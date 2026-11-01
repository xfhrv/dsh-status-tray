// DSHStatusTray —— Windows 任务栏托盘状态指示灯（.NET Framework 4.x / C# 5）
//
// 实现契约：docs/status-schema.md
// 编译：build.ps1（C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe，/codepage:65001）
//
// 结构：
//   Program          入口：参数解析 / 单实例 / 调试模式 / 全局异常兜底
//   TrayApp          ApplicationContext：NotifyIcon + 右键菜单 + 500ms 轮询 status.json
//   AgentSupervisor  守护 Node 状态引擎子进程（启动/重启/重定向日志）
//   IconPainter      用 System.Drawing 画 32x32 抗锯齿圆点图标
//   AppConfig        %LOCALAPPDATA%\DSHStatusTray\config.json 的读写与容错
//   StatusSnapshot   status.json 解析后的只读快照
//   JsonParser       极简 JSON 解析器（不引用第三方 / 不依赖 System.Web.Extensions）

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshStatusTray
{
    internal static class Program
    {
        internal const string MutexName = "Local\\DSHStatusTray";

        [STAThread]
        private static int Main(string[] args)
        {
            Options options;
            try
            {
                options = Options.Parse(args);
            }
            catch (Exception ex)
            {
                try
                {
                    Log.Init(Path.Combine(Paths.DataDir, "tray.log"));
                    Log.Error("命令行参数错误", ex);
                }
                catch
                {
                }
                return 2;
            }

            try
            {
                string dataDir = Paths.DataDir;
                Log.Init(Path.Combine(dataDir, "tray.log"));

                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += OnThreadException;
                AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;

                // 调试/验收模式：不创建托盘，也不占用单实例互斥体。
                if (!string.IsNullOrEmpty(options.RenderIconsDir))
                {
                    return DebugModes.RenderIcons(options);
                }
                if (options.OpenConsole)
                {
                    return DebugModes.OpenConsole();
                }
                if (options.OpenBalance)
                {
                    return DebugModes.OpenBalance(options);
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // v2 调试模式：--test-notify 走真实气泡/提示音代码路径，5 秒后 Environment.Exit(0)。
                // 与 --render-icons 一样不占用单实例互斥体，便于在正式托盘运行时做验收。
                if (!string.IsNullOrEmpty(options.TestNotify))
                {
                    try
                    {
                        AppConfig testConfig = AppConfig.LoadOrCreate(dataDir);
                        TrayApp testApp = new TrayApp(options, testConfig, dataDir, options.TestNotify);
                        Application.Run(testApp);
                        testApp.Shutdown();
                        return 0;
                    }
                    catch (Exception ex)
                    {
                        Log.Error("--test-notify 运行失败", ex);
                        return 1;
                    }
                }

                bool acquired = false;
                bool mayRun = false;
                Mutex mutex = null;
                try
                {
                    mutex = new Mutex(false, MutexName);
                    try
                    {
                        acquired = mutex.WaitOne(0, false);
                        mayRun = acquired;
                    }
                    catch (AbandonedMutexException)
                    {
                        // 上一个实例异常退出：互斥体归我们所有。
                        acquired = true;
                        mayRun = true;
                    }
                }
                catch (Exception ex)
                {
                    // 创建互斥体失败时不阻止工具本身使用，只记录日志。
                    Log.Error("创建单实例互斥体失败，继续运行", ex);
                    mayRun = true;
                }

                if (!mayRun)
                {
                    // 已有实例：静默退出。
                    return 0;
                }

                try
                {
                    AppConfig config = AppConfig.LoadOrCreate(dataDir);
                    TrayApp app = new TrayApp(options, config, dataDir);
                    Application.Run(app);
                    app.Shutdown();
                    return 0;
                }
                finally
                {
                    if (acquired && mutex != null)
                    {
                        try { mutex.ReleaseMutex(); }
                        catch { }
                    }
                    if (mutex != null)
                    {
                        try { mutex.Dispose(); }
                        catch { }
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error("程序异常退出", ex);
                return 1;
            }
        }

        private static void OnThreadException(object sender, ThreadExceptionEventArgs e)
        {
            Log.Error("UI 线程未处理异常", e == null ? null : e.Exception);
        }

        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Exception exception = e == null ? null : e.ExceptionObject as Exception;
            if (exception != null)
            {
                Log.Error("AppDomain 未处理异常", exception);
            }
            else
            {
                Log.ErrorText("AppDomain 未处理异常: " + (e == null ? "(unknown)" : Convert.ToString(e.ExceptionObject, CultureInfo.InvariantCulture)));
            }
        }
    }

    /// <summary>命令行参数（契约 §7.1）。</summary>
    internal sealed class Options
    {
        public string StatusPath;
        public bool NoAgent;
        public string RenderIconsDir;
        public bool OpenConsole;
        public string TestNotify;
        public bool OpenBalance;

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            if (args == null)
            {
                return options;
            }
            int index = 0;
            while (index < args.Length)
            {
                string argument = args[index];
                if (argument == null)
                {
                    index++;
                    continue;
                }
                string key = argument;
                string inlineValue = null;
                int equals = argument.IndexOf('=');
                if (argument.Length > 2 && argument[0] == '-' && argument[1] == '-' && equals > 2)
                {
                    key = argument.Substring(0, equals);
                    inlineValue = argument.Substring(equals + 1);
                }

                switch (key)
                {
                    case "--status":
                        options.StatusPath = TakeValue(args, ref index, key, inlineValue);
                        break;
                    case "--no-agent":
                        options.NoAgent = true;
                        break;
                    case "--render-icons":
                        options.RenderIconsDir = TakeValue(args, ref index, key, inlineValue);
                        break;
                    case "--open-console":
                        options.OpenConsole = true;
                        break;
                    case "--open-balance":
                        options.OpenBalance = true;
                        break;
                    case "--test-notify":
                        {
                            string testNotify = TakeValue(args, ref index, key, inlineValue);
                            testNotify = testNotify.Trim().ToLowerInvariant();
                            if (testNotify != "completion" && testNotify != "approval")
                            {
                                throw new ArgumentException("--test-notify 只支持 completion 或 approval");
                            }
                            options.TestNotify = testNotify;
                        }
                        break;
                    default:
                        // 未知参数忽略，保证向前兼容。
                        break;
                }
                index++;
            }
            return options;
        }

        private static string TakeValue(string[] args, ref int index, string key, string inlineValue)
        {
            if (inlineValue != null)
            {
                if (inlineValue.Length == 0)
                {
                    throw new ArgumentException("参数 " + key + " 的取值为空");
                }
                return inlineValue;
            }
            if (index + 1 >= args.Length || string.IsNullOrEmpty(args[index + 1]))
            {
                throw new ArgumentException("参数 " + key + " 缺少取值");
            }
            index++;
            return args[index];
        }
    }

    /// <summary>路径与外部程序定位。</summary>
    internal static class Paths
    {
        public static string DataDir
        {
            get
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(localAppData))
                {
                    localAppData = Path.GetTempPath();
                }
                return Path.Combine(localAppData, "DSHStatusTray");
            }
        }

        public static string AppBaseDir
        {
            get
            {
                try
                {
                    string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                    return baseDir == null ? string.Empty : baseDir;
                }
                catch
                {
                    return string.Empty;
                }
            }
        }

        /// <summary>exe 位于 <项目根>\bin\，其父目录即项目根。</summary>
        public static string ProjectDir
        {
            get
            {
                try
                {
                    string baseDir = AppBaseDir;
                    if (string.IsNullOrEmpty(baseDir))
                    {
                        return string.Empty;
                    }
                    return Path.GetFullPath(Path.Combine(baseDir, ".."));
                }
                catch
                {
                    return string.Empty;
                }
            }
        }

        /// <summary>状态引擎脚本定位：DSH_TRAY_AGENT → &lt;exe目录&gt;\..\src\status-agent.mjs → &lt;exe目录&gt;\status-agent.mjs。</summary>
        public static string FindAgentScript()
        {
            try
            {
                string overridePath = Environment.GetEnvironmentVariable("DSH_TRAY_AGENT");
                if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath))
                {
                    return Path.GetFullPath(overridePath);
                }
            }
            catch
            {
            }

            try
            {
                string projectDir = ProjectDir;
                if (!string.IsNullOrEmpty(projectDir))
                {
                    string candidate = Path.Combine(Path.Combine(projectDir, "src"), "status-agent.mjs");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
            }
            catch
            {
            }

            try
            {
                string candidate = Path.Combine(AppBaseDir, "status-agent.mjs");
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
            catch
            {
            }
            return null;
        }

        /// <summary>node.exe 定位：PATH 逐段 → 常见安装路径（契约 §7）。</summary>
        public static string FindNodeExe()
        {
            try
            {
                string pathEnv = Environment.GetEnvironmentVariable("PATH");
                if (!string.IsNullOrEmpty(pathEnv))
                {
                    string[] segments = pathEnv.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                    for (int i = 0; i < segments.Length; i++)
                    {
                        string dir = segments[i].Trim().Trim('"');
                        if (dir.Length == 0)
                        {
                            continue;
                        }
                        try
                        {
                            string candidate = Path.Combine(dir, "node.exe");
                            if (File.Exists(candidate))
                            {
                                return candidate;
                            }
                        }
                        catch
                        {
                        }
                    }
                }
            }
            catch
            {
            }

            List<string> candidates = new List<string>();
            try
            {
                string programFiles = Environment.GetEnvironmentVariable("ProgramFiles");
                if (string.IsNullOrEmpty(programFiles))
                {
                    programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                }
                if (!string.IsNullOrEmpty(programFiles))
                {
                    candidates.Add(Path.Combine(Path.Combine(programFiles, "nodejs"), "node.exe"));
                }
            }
            catch
            {
            }
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrEmpty(localAppData))
                {
                    candidates.Add(Path.Combine(Path.Combine(Path.Combine(localAppData, "Programs"), "nodejs"), "node.exe"));
                }
            }
            catch
            {
            }
            try
            {
                string programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
                if (string.IsNullOrEmpty(programFilesX86))
                {
                    programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
                }
                if (!string.IsNullOrEmpty(programFilesX86))
                {
                    candidates.Add(Path.Combine(Path.Combine(programFilesX86, "nodejs"), "node.exe"));
                }
            }
            catch
            {
            }

            for (int i = 0; i < candidates.Count; i++)
            {
                try
                {
                    if (File.Exists(candidates[i]))
                    {
                        return candidates[i];
                    }
                }
                catch
                {
                }
            }
            return null;
        }
    }

    internal static class TimeUtil
    {
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public static long NowEpochMs()
        {
            return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
        }

        public static long EpochMs(DateTime utc)
        {
            return (long)(utc.ToUniversalTime() - Epoch).TotalMilliseconds;
        }

        /// <summary>Environment.TickCount 差值，正确处理 32 位回绕。</summary>
        public static int ElapsedMs(int sinceTick)
        {
            return unchecked(Environment.TickCount - sinceTick);
        }

        /// <summary>epoch 毫秒 → 本地时间字符串（非法/0 返回空串）。</summary>
        public static string FormatLocalTime(long epochMs, string format)
        {
            if (epochMs <= 0 || string.IsNullOrEmpty(format))
            {
                return string.Empty;
            }
            try
            {
                return Epoch.AddMilliseconds(epochMs).ToLocalTime().ToString(format, CultureInfo.InvariantCulture);
            }
            catch
            {
                return string.Empty;
            }
        }
    }

    /// <summary>托盘自身日志（tray.log，追加；超过 1MB 轮转覆盖）。所有写入失败静默忽略。</summary>
    internal static class Log
    {
        private static readonly object Gate = new object();
        // 带 BOM 的 UTF-8：Windows PowerShell 5.1 / 旧版记事本读取中文不乱码。仅在新建文件时写入 BOM。
        private static readonly UTF8Encoding Utf8Bom = new UTF8Encoding(true);
        private static string _path;

        public static void Init(string path)
        {
            _path = path;
        }

        public static void Info(string message)
        {
            Write("INFO", message);
        }

        public static void ErrorText(string message)
        {
            Write("ERROR", message);
        }

        public static void Error(string message, Exception exception)
        {
            Write("ERROR", message + (exception == null ? string.Empty : ": " + Describe(exception)));
        }

        public static string Describe(Exception exception)
        {
            if (exception == null)
            {
                return "(null)";
            }
            StringBuilder builder = new StringBuilder();
            Exception current = exception;
            int depth = 0;
            while (current != null && depth < 5)
            {
                if (depth > 0)
                {
                    builder.Append(" <- ");
                }
                builder.Append(current.GetType().Name);
                builder.Append(": ");
                builder.Append(current.Message);
                current = current.InnerException;
                depth++;
            }
            return builder.ToString();
        }

        private static void Write(string level, string message)
        {
            string path = _path;
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            lock (Gate)
            {
                try
                {
                    string dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }
                    Rotate(path);
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                        + " [" + level + "] " + message;
                    using (FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                    using (StreamWriter writer = new StreamWriter(stream, Utf8Bom))
                    {
                        writer.WriteLine(line);
                    }
                }
                catch
                {
                    // 日志失败绝不影响主流程。
                }
            }
        }

        private static void Rotate(string path)
        {
            try
            {
                FileInfo info = new FileInfo(path);
                if (info.Exists && info.Length > 1024 * 1024)
                {
                    File.Delete(path);
                }
            }
            catch
            {
            }
        }
    }

    /// <summary>极简 JSON 解析器：对象→Dictionary&lt;string,object&gt;、数组→List&lt;object&gt;、数值→double。</summary>
    internal sealed class JsonParser
    {
        private readonly string _text;
        private int _position;

        private JsonParser(string text)
        {
            _text = text;
            _position = 0;
        }

        public static object Parse(string text)
        {
            if (text == null)
            {
                throw new ArgumentNullException("text");
            }
            JsonParser parser = new JsonParser(text);
            parser.SkipWhitespace();
            if (parser._position >= parser._text.Length)
            {
                throw new FormatException("JSON 内容为空");
            }
            object value = parser.ParseValue();
            parser.SkipWhitespace();
            if (parser._position < parser._text.Length)
            {
                throw new FormatException("JSON 尾部存在多余字符（位置 " + parser._position + "）");
            }
            return value;
        }

        private void SkipWhitespace()
        {
            while (_position < _text.Length)
            {
                char c = _text[_position];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n')
                {
                    _position++;
                }
                else
                {
                    break;
                }
            }
        }

        private object ParseValue()
        {
            SkipWhitespace();
            if (_position >= _text.Length)
            {
                throw new FormatException("JSON 意外结束");
            }
            char c = _text[_position];
            switch (c)
            {
                case '{':
                    return ParseObject();
                case '[':
                    return ParseArray();
                case '"':
                    return ParseString();
                case 't':
                    ExpectWord("true");
                    return true;
                case 'f':
                    ExpectWord("false");
                    return false;
                case 'n':
                    ExpectWord("null");
                    return null;
                default:
                    return ParseNumber();
            }
        }

        private Dictionary<string, object> ParseObject()
        {
            Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
            _position++; // '{'
            SkipWhitespace();
            if (_position < _text.Length && _text[_position] == '}')
            {
                _position++;
                return result;
            }
            while (true)
            {
                SkipWhitespace();
                if (_position >= _text.Length || _text[_position] != '"')
                {
                    throw new FormatException("JSON 对象键必须是字符串（位置 " + _position + "）");
                }
                string key = ParseString();
                SkipWhitespace();
                if (_position >= _text.Length || _text[_position] != ':')
                {
                    throw new FormatException("JSON 对象缺少冒号（位置 " + _position + "）");
                }
                _position++;
                object value = ParseValue();
                result[key] = value;
                SkipWhitespace();
                if (_position >= _text.Length)
                {
                    throw new FormatException("JSON 对象未闭合");
                }
                char c = _text[_position];
                if (c == ',')
                {
                    _position++;
                    continue;
                }
                if (c == '}')
                {
                    _position++;
                    return result;
                }
                throw new FormatException("JSON 对象出现意外字符（位置 " + _position + "）");
            }
        }

        private List<object> ParseArray()
        {
            List<object> result = new List<object>();
            _position++; // '['
            SkipWhitespace();
            if (_position < _text.Length && _text[_position] == ']')
            {
                _position++;
                return result;
            }
            while (true)
            {
                object value = ParseValue();
                result.Add(value);
                SkipWhitespace();
                if (_position >= _text.Length)
                {
                    throw new FormatException("JSON 数组未闭合");
                }
                char c = _text[_position];
                if (c == ',')
                {
                    _position++;
                    continue;
                }
                if (c == ']')
                {
                    _position++;
                    return result;
                }
                throw new FormatException("JSON 数组出现意外字符（位置 " + _position + "）");
            }
        }

        private string ParseString()
        {
            StringBuilder builder = new StringBuilder();
            _position++; // '"'
            while (_position < _text.Length)
            {
                char c = _text[_position];
                if (c == '"')
                {
                    _position++;
                    return builder.ToString();
                }
                if (c == '\\')
                {
                    _position++;
                    if (_position >= _text.Length)
                    {
                        throw new FormatException("JSON 字符串转义不完整");
                    }
                    char escape = _text[_position];
                    switch (escape)
                    {
                        case '"':
                            builder.Append('"');
                            break;
                        case '\\':
                            builder.Append('\\');
                            break;
                        case '/':
                            builder.Append('/');
                            break;
                        case 'b':
                            builder.Append('\b');
                            break;
                        case 'f':
                            builder.Append('\f');
                            break;
                        case 'n':
                            builder.Append('\n');
                            break;
                        case 'r':
                            builder.Append('\r');
                            break;
                        case 't':
                            builder.Append('\t');
                            break;
                        case 'u':
                            if (_position + 4 >= _text.Length)
                            {
                                throw new FormatException("JSON \\u 转义不完整");
                            }
                            string hex = _text.Substring(_position + 1, 4);
                            int code;
                            if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            {
                                throw new FormatException("JSON \\u 转义非法: " + hex);
                            }
                            builder.Append((char)code);
                            _position += 4;
                            break;
                        default:
                            throw new FormatException("JSON 字符串包含非法转义: \\" + escape);
                    }
                    _position++;
                    continue;
                }
                builder.Append(c);
                _position++;
            }
            throw new FormatException("JSON 字符串未闭合");
        }

        private double ParseNumber()
        {
            int start = _position;
            while (_position < _text.Length)
            {
                char c = _text[_position];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
                {
                    _position++;
                }
                else
                {
                    break;
                }
            }
            if (_position == start)
            {
                throw new FormatException("JSON 数值非法（位置 " + start + "）");
            }
            string token = _text.Substring(start, _position - start);
            double value;
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
            {
                throw new FormatException("JSON 数值非法: " + token);
            }
            return value;
        }

        private void ExpectWord(string word)
        {
            if (_position + word.Length > _text.Length
                || string.CompareOrdinal(_text, _position, word, 0, word.Length) != 0)
            {
                throw new FormatException("JSON 字面量非法（位置 " + _position + "）");
            }
            _position += word.Length;
        }
    }

    /// <summary>JSON 字典的类型化取值辅助。</summary>
    internal static class J
    {
        public static Dictionary<string, object> Object(Dictionary<string, object> source, string key)
        {
            if (source == null)
            {
                return null;
            }
            object value;
            if (!source.TryGetValue(key, out value))
            {
                return null;
            }
            return value as Dictionary<string, object>;
        }

        public static List<object> Array(Dictionary<string, object> source, string key)
        {
            if (source == null)
            {
                return null;
            }
            object value;
            if (!source.TryGetValue(key, out value))
            {
                return null;
            }
            return value as List<object>;
        }

        public static string String(Dictionary<string, object> source, string key)
        {
            if (source == null)
            {
                return null;
            }
            object value;
            if (!source.TryGetValue(key, out value))
            {
                return null;
            }
            return value as string;
        }

        public static long Long(Dictionary<string, object> source, string key, long fallback)
        {
            if (source == null)
            {
                return fallback;
            }
            object value;
            if (!source.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            if (value is double)
            {
                double number = (double)value;
                if (double.IsNaN(number) || double.IsInfinity(number))
                {
                    return fallback;
                }
                return (long)number;
            }
            string text = value as string;
            if (text != null)
            {
                long parsed;
                if (long.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                {
                    return parsed;
                }
            }
            return fallback;
        }

        public static int Int(Dictionary<string, object> source, string key, int fallback)
        {
            long value = Long(source, key, fallback);
            if (value < int.MinValue)
            {
                return int.MinValue;
            }
            if (value > int.MaxValue)
            {
                return int.MaxValue;
            }
            return (int)value;
        }

        public static bool Bool(Dictionary<string, object> source, string key, bool fallback)
        {
            if (source == null)
            {
                return fallback;
            }
            object value;
            if (!source.TryGetValue(key, out value) || value == null)
            {
                return fallback;
            }
            if (value is bool)
            {
                return (bool)value;
            }
            return fallback;
        }
    }

    /// <summary>config.json（契约 §6 + alerts-spec §3）：consoleUrl / pollMs / colors / 通知与提示音。</summary>
    internal sealed class AppConfig
    {
        public const string DefaultConsoleUrl = "http://127.0.0.1:3080";
        public const int DefaultPollMs = 500;
        /// <summary>默认不绑定具体 wav：留空表示使用系统提示音；如需自定义，在 config.json 的 soundFile 里填路径。</summary>
        public const string DefaultSoundFile = "";
        public const string DefaultTopUpUrl = "https://platform.deepseek.com/top_up";

        private static readonly string[] StateNames = new string[] { "working", "approval", "idle", "offline" };
        private static readonly string[] DefaultColorHex = new string[] { "#F2B705", "#E5484D", "#2FA84F", "#9AA0A6" };
        // v2 通知键 + v3 余额键：缺失时启动写回补齐（alerts-spec §3 / account-balance-spec §4）。
        private static readonly string[] RequiredConfigKeys = new string[]
        {
            "notifyCompletion", "notifyApproval", "playSound", "soundFile",
            "showBalance", "topUpUrl"
        };

        private readonly Dictionary<string, Color> _colors;
        private string _consoleUrl;
        private int _pollMs;
        private bool _notifyCompletion;
        private bool _notifyApproval;
        private bool _playSound;
        private string _soundFile;
        private bool _showBalance;
        private string _topUpUrl;

        private AppConfig()
        {
            _consoleUrl = DefaultConsoleUrl;
            _pollMs = DefaultPollMs;
            _notifyCompletion = true;
            _notifyApproval = true;
            _playSound = true;
            _soundFile = DefaultSoundFile;
            _showBalance = true;
            _topUpUrl = DefaultTopUpUrl;
            _colors = new Dictionary<string, Color>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < StateNames.Length; i++)
            {
                Color color;
                if (TryParseHexColor(DefaultColorHex[i], out color))
                {
                    _colors[StateNames[i]] = color;
                }
            }
        }

        public string ConsoleUrl
        {
            get { return _consoleUrl; }
        }

        public int PollMs
        {
            get { return _pollMs; }
        }

        public bool NotifyCompletion
        {
            get { return _notifyCompletion; }
        }

        public bool NotifyApproval
        {
            get { return _notifyApproval; }
        }

        public bool PlaySound
        {
            get { return _playSound; }
        }

        public string SoundFile
        {
            get { return _soundFile; }
        }

        public bool ShowBalance
        {
            get { return _showBalance; }
        }

        /// <summary>点击余额项打开的地址；空字符串表示交给 status.json 的 account.topUpUrl / 内置默认值。</summary>
        public string TopUpUrl
        {
            get { return _topUpUrl; }
        }

        public static AppConfig Defaults()
        {
            return new AppConfig();
        }

        /// <summary>读取配置；缺失或解析失败时返回默认值（不写文件）。</summary>
        public static AppConfig Load(string dataDir)
        {
            AppConfig config = Defaults();
            try
            {
                string path = Path.Combine(dataDir, "config.json");
                if (File.Exists(path))
                {
                    string text = ReadAllTextShared(path);
                    if (text != null && text.Trim().Length > 0)
                    {
                        object parsed = JsonParser.Parse(text);
                        Dictionary<string, object> root = parsed as Dictionary<string, object>;
                        if (root != null)
                        {
                            config.Apply(root);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error("config.json 解析失败，使用内置默认值", ex);
            }
            return config;
        }

        /// <summary>
        /// 启动时读取配置：文件缺失则写默认；文件存在但缺 v2/v3 新增键时写回补齐（alerts-spec §3 / account-balance-spec §4）。
        /// 解析失败时使用内置默认值，不覆盖用户的损坏文件。
        /// </summary>
        public static AppConfig LoadOrCreate(string dataDir)
        {
            string path = Path.Combine(dataDir, "config.json");
            AppConfig config = Defaults();
            try
            {
                if (!File.Exists(path))
                {
                    Directory.CreateDirectory(dataDir);
                    WriteConfigFile(path, config);
                    return config;
                }

                string text = null;
                try
                {
                    text = ReadAllTextShared(path);
                }
                catch (Exception ex)
                {
                    Log.Error("读取 config.json 失败，使用内置默认值", ex);
                }
                if (text == null || text.Trim().Length == 0)
                {
                    WriteConfigFile(path, config);
                    return config;
                }

                object parsed = JsonParser.Parse(text);
                Dictionary<string, object> root = parsed as Dictionary<string, object>;
                if (root == null)
                {
                    return config;
                }
                config.Apply(root);

                // v5：旧 colors（含 restricted/darkgray）需要迁移并写回
                bool legacyColors = HasLegacyColors(root);
                bool needWrite = legacyColors;
                if (!needWrite)
                {
                    for (int i = 0; i < RequiredConfigKeys.Length; i++)
                    {
                        if (!root.ContainsKey(RequiredConfigKeys[i]))
                        {
                            needWrite = true;
                            break;
                        }
                    }
                }
                if (needWrite)
                {
                    WriteConfigFile(path, config);
                    if (legacyColors)
                    {
                        Log.Info("config.json colors 已迁移到 v5 四色状态模型并写回");
                    }
                    else
                    {
                        Log.Info("config.json 已补齐缺失的默认配置键（v2 通知 / v3 余额）");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error("config.json 解析/写入失败，使用内置默认值", ex);
            }
            return config;
        }

        public Color GetColor(string state)
        {
            if (!string.IsNullOrEmpty(state))
            {
                Color color;
                if (_colors.TryGetValue(state, out color))
                {
                    return color;
                }
            }
            return Color.FromArgb(154, 160, 166);
        }

        public bool TryParseHexColor(string value, out Color color)
        {
            return AppConfig.TryParseHexColorStatic(value, out color);
        }

        /// <summary>旧配置是否含 v5 前的 restricted / darkgray 颜色键（用于触发迁移写回）。</summary>
        private static bool HasLegacyColors(Dictionary<string, object> root)
        {
            Dictionary<string, object> colors = J.Object(root, "colors");
            if (colors == null)
            {
                return false;
            }
            foreach (KeyValuePair<string, object> pair in colors)
            {
                string key = pair.Key;
                if (string.IsNullOrEmpty(key))
                {
                    continue;
                }
                string trimmed = key.Trim();
                if (string.Equals(trimmed, "restricted", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(trimmed, "darkgray", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private Color DefaultColorFor(string state)
        {
            for (int i = 0; i < StateNames.Length; i++)
            {
                if (StateNames[i] == state)
                {
                    Color color;
                    if (TryParseHexColorStatic(DefaultColorHex[i], out color))
                    {
                        return color;
                    }
                }
            }
            return Color.FromArgb(154, 160, 166);
        }

        private static Color LookupOr(Dictionary<string, Color> source, string key, Color fallback)
        {
            if (source != null && !string.IsNullOrEmpty(key))
            {
                Color color;
                if (source.TryGetValue(key, out color))
                {
                    return color;
                }
            }
            return fallback;
        }

        private void Apply(Dictionary<string, object> root)
        {
            string consoleUrl = J.String(root, "consoleUrl");
            if (!string.IsNullOrEmpty(consoleUrl))
            {
                _consoleUrl = consoleUrl.Trim();
            }

            int pollMs = J.Int(root, "pollMs", _pollMs);
            if (pollMs < 250)
            {
                pollMs = 250;
            }
            if (pollMs > 10000)
            {
                pollMs = 10000;
            }
            _pollMs = pollMs;

            Dictionary<string, object> colors = J.Object(root, "colors");
            if (colors != null)
            {
                // 先解析出旧配置里的颜色（键名大小写不敏感）
                Dictionary<string, Color> parsed = new Dictionary<string, Color>(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, object> pair in colors)
                {
                    string state = pair.Key;
                    if (string.IsNullOrEmpty(state))
                    {
                        continue;
                    }
                    string hex = pair.Value as string;
                    if (string.IsNullOrEmpty(hex))
                    {
                        continue;
                    }
                    Color color;
                    if (TryParseHexColorStatic(hex, out color))
                    {
                        parsed[state.Trim()] = color;
                    }
                }

                if (parsed.ContainsKey("restricted") || parsed.ContainsKey("darkgray"))
                {
                    // v5 迁移（state-model-v5 §2.4）：
                    // 新 idle = 旧 restricted（缺省 #2FA84F）；新 offline = 旧 idle（缺省 #9AA0A6）；
                    // 旧 darkgray / 旧 offline 丢弃；working/approval 原样保留。
                    Color working = LookupOr(parsed, "working", DefaultColorFor("working"));
                    Color approval = LookupOr(parsed, "approval", DefaultColorFor("approval"));
                    Color idle = LookupOr(parsed, "restricted", DefaultColorFor("idle"));
                    Color offline = LookupOr(parsed, "idle", DefaultColorFor("offline"));
                    _colors.Clear();
                    _colors["working"] = working;
                    _colors["approval"] = approval;
                    _colors["idle"] = idle;
                    _colors["offline"] = offline;
                }
                else
                {
                    foreach (KeyValuePair<string, Color> pair in parsed)
                    {
                        _colors[pair.Key] = pair.Value;
                    }
                }
            }

            _notifyCompletion = J.Bool(root, "notifyCompletion", true);
            _notifyApproval = J.Bool(root, "notifyApproval", true);
            _playSound = J.Bool(root, "playSound", true);
            string soundFile = J.String(root, "soundFile");
            if (!string.IsNullOrEmpty(soundFile) && soundFile.Trim().Length > 0)
            {
                _soundFile = soundFile.Trim();
            }

            _showBalance = J.Bool(root, "showBalance", true);
            if (root.ContainsKey("topUpUrl"))
            {
                string topUpUrl = J.String(root, "topUpUrl");
                if (topUpUrl != null)
                {
                    // 显式空字符串表示"交给 status.json 的 account.topUpUrl / 内置默认值"。
                    _topUpUrl = topUpUrl.Trim();
                }
            }
        }

        private static bool TryParseHexColorStatic(string value, out Color color)
        {
            color = Color.Empty;
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }
            string text = value.Trim();
            if (text.StartsWith("#", StringComparison.Ordinal))
            {
                text = text.Substring(1);
            }
            if (text.Length == 3)
            {
                // #RGB -> #RRGGBB
                text = new string(new char[]
                {
                    text[0], text[0], text[1], text[1], text[2], text[2]
                });
            }
            if (text.Length != 6)
            {
                return false;
            }
            int red;
            int green;
            int blue;
            if (!int.TryParse(text.Substring(0, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out red)
                || !int.TryParse(text.Substring(2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out green)
                || !int.TryParse(text.Substring(4, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out blue))
            {
                return false;
            }
            color = Color.FromArgb(red, green, blue);
            return true;
        }

        /// <summary>把当前生效配置写回 config.json（默认值 + 用户已有覆盖值），含 v2 四个通知键。</summary>
        private static void WriteConfigFile(string path, AppConfig config)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("{\n");
            builder.Append("  \"consoleUrl\": \"").Append(EscapeJson(config._consoleUrl)).Append("\",\n");
            builder.Append("  \"pollMs\": ").Append(config._pollMs.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            builder.Append("  \"colors\": {\n");
            for (int i = 0; i < StateNames.Length; i++)
            {
                Color color = config.GetColor(StateNames[i]);
                builder.Append("    \"").Append(StateNames[i]).Append("\": \"").Append(ToHex(color)).Append("\"");
                if (i < StateNames.Length - 1)
                {
                    builder.Append(",");
                }
                builder.Append("\n");
            }
            builder.Append("  },\n");
            builder.Append("  \"notifyCompletion\": ").Append(config._notifyCompletion ? "true" : "false").Append(",\n");
            builder.Append("  \"notifyApproval\": ").Append(config._notifyApproval ? "true" : "false").Append(",\n");
            builder.Append("  \"playSound\": ").Append(config._playSound ? "true" : "false").Append(",\n");
            builder.Append("  \"soundFile\": \"").Append(EscapeJson(config._soundFile)).Append("\",\n");
            builder.Append("  \"showBalance\": ").Append(config._showBalance ? "true" : "false").Append(",\n");
            builder.Append("  \"topUpUrl\": \"").Append(EscapeJson(config._topUpUrl)).Append("\"\n");
            builder.Append("}\n");

            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllText(path, builder.ToString(), new UTF8Encoding(false));
        }

        private static string ToHex(Color color)
        {
            return "#" + color.R.ToString("X2", CultureInfo.InvariantCulture)
                + color.G.ToString("X2", CultureInfo.InvariantCulture)
                + color.B.ToString("X2", CultureInfo.InvariantCulture);
        }

        private static string EscapeJson(string value)
        {
            if (value == null)
            {
                return string.Empty;
            }
            StringBuilder builder = new StringBuilder(value.Length + 8);
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (c < ' ')
                        {
                            builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(c);
                        }
                        break;
                }
            }
            return builder.ToString();
        }

        private static string ReadAllTextShared(string path)
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (stream.Length == 0)
                {
                    return null;
                }
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
                {
                    return reader.ReadToEnd();
                }
            }
        }
    }

    /// <summary>account（account-balance-spec §2）：DeepSeek 账户余额信息，由状态引擎写入。</summary>
    internal sealed class AccountInfo
    {
        public string Status;
        public string Balance;
        public string Currency;
        public string BonusBalance;
        public long FetchedAt;
        public string Error;
        public string TopUpUrl;
    }

    /// <summary>alerts.completion（alerts-spec §2）：主会话最近一次 turn/end。</summary>
    internal sealed class CompletionAlert
    {
        public string Key;
        public long At;
        public string SessionId;
        public string Title;
        public bool Main;
    }

    /// <summary>alerts.attention（alerts-spec §2）：需要用户处理的审批或问题。</summary>
    internal sealed class AttentionAlert
    {
        public string Key;
        public string Kind;
        public long At;
        public string ToolName;
        public string SessionId;
        public string Title;
        public bool Main;
        public int PendingCount;
    }

    /// <summary>status.json 解析结果（契约 §4 + alerts-spec §2）。</summary>
    internal sealed class StatusSnapshot
    {
        private static readonly string[] ValidStates = new string[] { "approval", "working", "idle", "offline" };

        public long GeneratedAt;
        public string State;
        public string StateLabel;
        public string ColorName;
        public string Tooltip;
        public string MenuStatus;
        public string MenuDetail;
        public string AgentError;
        public string SessionTitle;
        public CompletionAlert Completion;
        public AttentionAlert Attention;
        public AccountInfo Account;

        public static StatusSnapshot FromJson(Dictionary<string, object> root)
        {
            StatusSnapshot snapshot = new StatusSnapshot();
            snapshot.GeneratedAt = J.Long(root, "generatedAt", 0L);
            snapshot.Tooltip = J.String(root, "tooltip");
            snapshot.MenuStatus = J.String(root, "menuStatus");
            snapshot.MenuDetail = J.String(root, "menuDetail");
            snapshot.AgentError = J.String(root, "agentError");
            snapshot.ColorName = NormalizeToken(J.String(root, "color"));
            snapshot.State = NormalizeState(J.String(root, "state"));

            Dictionary<string, object> session = J.Object(root, "activeSession");
            if (session != null)
            {
                snapshot.SessionTitle = J.String(session, "title");
            }

            // v2 alerts（缺失/非法时保持 null，不影响 v1 数据）
            Dictionary<string, object> alerts = J.Object(root, "alerts");
            if (alerts != null)
            {
                snapshot.Completion = ParseCompletionAlert(J.Object(alerts, "completion"));
                snapshot.Attention = ParseAttentionAlert(J.Object(alerts, "attention"));
            }

            // v3 account（缺失/非法时保持 null，不影响 v1/v2 数据）
            snapshot.Account = ParseAccountInfo(J.Object(root, "account"));

            if (snapshot.State == null)
            {
                snapshot.State = StateFromColor(snapshot.ColorName);
            }
            if (snapshot.State == null)
            {
                snapshot.State = "offline";
            }
            if (string.IsNullOrEmpty(snapshot.ColorName))
            {
                snapshot.ColorName = ColorFromState(snapshot.State);
            }
            snapshot.StateLabel = J.String(root, "stateLabel");
            if (string.IsNullOrEmpty(snapshot.StateLabel))
            {
                snapshot.StateLabel = LabelFromState(snapshot.State);
            }
            return snapshot;
        }

        private static AccountInfo ParseAccountInfo(Dictionary<string, object> value)
        {
            if (value == null)
            {
                return null;
            }
            AccountInfo account = new AccountInfo();
            account.Status = J.String(value, "status");
            account.Balance = J.String(value, "balance");
            account.Currency = J.String(value, "currency");
            account.BonusBalance = J.String(value, "bonusBalance");
            account.FetchedAt = J.Long(value, "fetchedAt", 0L);
            account.Error = J.String(value, "error");
            account.TopUpUrl = J.String(value, "topUpUrl");
            return account;
        }

        private static CompletionAlert ParseCompletionAlert(Dictionary<string, object> value)
        {
            if (value == null)
            {
                return null;
            }
            CompletionAlert alert = new CompletionAlert();
            alert.Key = J.String(value, "key");
            if (string.IsNullOrEmpty(alert.Key))
            {
                // 无 key 视为非法，不参与通知（契约 §4.3 要求 key 非空）
                return null;
            }
            alert.At = J.Long(value, "at", 0L);
            alert.SessionId = J.String(value, "sessionId");
            alert.Title = J.String(value, "title");
            alert.Main = J.Bool(value, "main", true);
            return alert;
        }

        private static AttentionAlert ParseAttentionAlert(Dictionary<string, object> value)
        {
            if (value == null)
            {
                return null;
            }
            AttentionAlert alert = new AttentionAlert();
            alert.Key = J.String(value, "key");
            if (string.IsNullOrEmpty(alert.Key))
            {
                return null;
            }
            alert.Kind = J.String(value, "kind");
            alert.At = J.Long(value, "at", 0L);
            alert.ToolName = J.String(value, "toolName");
            alert.SessionId = J.String(value, "sessionId");
            alert.Title = J.String(value, "title");
            alert.Main = J.Bool(value, "main", true);
            alert.PendingCount = J.Int(value, "pendingCount", 1);
            return alert;
        }

        public static string StateFromColor(string colorName)
        {
            string color = NormalizeToken(colorName);
            if (color == null)
            {
                return null;
            }
            switch (color)
            {
                case "red":
                    return "approval";
                case "yellow":
                    return "working";
                case "green":
                    return "idle";
                case "gray":
                    return "offline";
                // v5 兼容旧夹具的容错映射（不作为新输出）
                case "darkgray":
                    return "offline";
                case "restricted":
                    return "idle";
                default:
                    return null;
            }
        }

        public static string ColorFromState(string state)
        {
            switch (state)
            {
                case "approval":
                    return "red";
                case "working":
                    return "yellow";
                case "idle":
                    return "green";
                case "offline":
                    return "gray";
                // v5 旧 token 容错
                case "restricted":
                    return "green";
                case "darkgray":
                    return "gray";
                default:
                    return "gray";
            }
        }

        public static string LabelFromState(string state)
        {
            switch (state)
            {
                case "approval":
                    return "需要审批";
                case "working":
                    return "工作中";
                case "idle":
                    return "空闲";
                case "offline":
                    return "未运行";
                // v5 旧 token 容错
                case "restricted":
                    return "空闲";
                case "darkgray":
                    return "未运行";
                default:
                    return "未知";
            }
        }

        private static string NormalizeState(string value)
        {
            string token = NormalizeToken(value);
            if (token == null)
            {
                return null;
            }
            for (int i = 0; i < ValidStates.Length; i++)
            {
                if (ValidStates[i] == token)
                {
                    return token;
                }
            }
            // v5 兼容旧 status.json 的 restricted 状态（视为空闲）
            if (token == "restricted")
            {
                return "idle";
            }
            if (token == "darkgray")
            {
                return "offline";
            }
            return null;
        }

        private static string NormalizeToken(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return null;
            }
            string token = value.Trim().ToLowerInvariant();
            return token.Length == 0 ? null : token;
        }
    }

    /// <summary>32x32 抗锯齿圆点图标：填充色 + 深色描边 + 1px 高光。</summary>
    internal static class IconPainter
    {
        public const int Size = 32;

        public static Bitmap CreateBitmap(Color fill)
        {
            Bitmap bitmap = new Bitmap(Size, Size, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.Clear(Color.Transparent);

                Color outline = Darken(fill, 0.55f);
                // 外圈：半径约 13.5px 的深色描边
                using (SolidBrush outlineBrush = new SolidBrush(outline))
                {
                    graphics.FillEllipse(outlineBrush, new RectangleF(2.5f, 2.5f, 27f, 27f));
                }
                // 主体：半径约 12px 的填充圆（契约要求半径 13，含描边后整体约 13.5）
                using (SolidBrush fillBrush = new SolidBrush(fill))
                {
                    graphics.FillEllipse(fillBrush, new RectangleF(4f, 4f, 24f, 24f));
                }
                // 左上角 1px 级高光
                using (SolidBrush highlight = new SolidBrush(Color.FromArgb(120, 255, 255, 255)))
                {
                    graphics.FillEllipse(highlight, new RectangleF(9.5f, 8f, 9f, 6.5f));
                }
            }
            return bitmap;
        }

        private static Color Darken(Color color, float factor)
        {
            int red = (int)(color.R * factor);
            int green = (int)(color.G * factor);
            int blue = (int)(color.B * factor);
            if (red < 0) { red = 0; }
            if (red > 255) { red = 255; }
            if (green < 0) { green = 0; }
            if (green > 255) { green = 255; }
            if (blue < 0) { blue = 0; }
            if (blue > 255) { blue = 255; }
            return Color.FromArgb(255, red, green, blue);
        }
    }

    internal static class NativeMethods
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr iconHandle);
    }

    internal static class ConsoleLauncher
    {
        public static bool Open(string url)
        {
            return Open(url, "打开控制台");
        }

        /// <param name="actionLabel">失败日志里的动作名，例如 "打开充值页"。</param>
        public static bool Open(string url, string actionLabel)
        {
            try
            {
                string target = string.IsNullOrEmpty(url) ? AppConfig.DefaultConsoleUrl : url.Trim();
                ProcessStartInfo startInfo = new ProcessStartInfo(target);
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error((actionLabel == null ? "打开链接" : actionLabel) + "失败: " + url, ex);
                return false;
            }
        }
    }

    /// <summary>
    /// 充值余额菜单的打开逻辑（account-balance-spec §5.3）：
    /// config.topUpUrl 非空优先 > status.json 的 account.topUpUrl > 内置默认充值页。
    /// </summary>
    internal static class TopUpLauncher
    {
        public static string ResolveUrl(AppConfig config, StatusSnapshot snapshot)
        {
            if (config != null && !string.IsNullOrEmpty(config.TopUpUrl) && config.TopUpUrl.Trim().Length > 0)
            {
                return config.TopUpUrl.Trim();
            }
            if (snapshot != null && snapshot.Account != null
                && !string.IsNullOrEmpty(snapshot.Account.TopUpUrl) && snapshot.Account.TopUpUrl.Trim().Length > 0)
            {
                return snapshot.Account.TopUpUrl.Trim();
            }
            return AppConfig.DefaultTopUpUrl;
        }

        public static bool Open(AppConfig config, StatusSnapshot snapshot)
        {
            string url = ResolveUrl(config, snapshot);
            bool opened = ConsoleLauncher.Open(url, "打开充值页");
            if (opened)
            {
                Log.Info("打开充值页: " + url);
            }
            return opened;
        }
    }

    /// <summary>--render-icons / --open-console 验收模式（契约 §7.1）。</summary>
    internal static class DebugModes
    {
        private static readonly string[] RenderStates = new string[] { "working", "approval", "idle", "offline" };

        public static int RenderIcons(Options options)
        {
            try
            {
                string dir = Path.GetFullPath(options.RenderIconsDir);
                Directory.CreateDirectory(dir);
                AppConfig config = AppConfig.Load(Paths.DataDir);
                for (int i = 0; i < RenderStates.Length; i++)
                {
                    string state = RenderStates[i];
                    using (Bitmap bitmap = IconPainter.CreateBitmap(config.GetColor(state)))
                    {
                        bitmap.Save(Path.Combine(dir, state + ".png"), ImageFormat.Png);
                    }
                }
                Log.Info("--render-icons 已导出 " + RenderStates.Length + " 张状态图标到 " + dir);
                return 0;
            }
            catch (Exception ex)
            {
                Log.Error("--render-icons 失败", ex);
                return 1;
            }
        }

        public static int OpenConsole()
        {
            try
            {
                AppConfig config = AppConfig.Load(Paths.DataDir);
                bool opened = ConsoleLauncher.Open(config.ConsoleUrl);
                Log.Info("--open-console " + (opened ? "成功" : "失败") + ": " + config.ConsoleUrl);
                return opened ? 0 : 1;
            }
            catch (Exception ex)
            {
                Log.Error("--open-console 失败", ex);
                return 1;
            }
        }

        /// <summary>--open-balance：执行与点击"充值余额"完全相同的打开逻辑后退出（account-balance-spec §7）。</summary>
        public static int OpenBalance(Options options)
        {
            try
            {
                AppConfig config = AppConfig.Load(Paths.DataDir);
                string statusPath = Path.Combine(Paths.DataDir, "status.json");
                if (options != null && !string.IsNullOrEmpty(options.StatusPath))
                {
                    try
                    {
                        statusPath = Path.GetFullPath(options.StatusPath);
                    }
                    catch
                    {
                        statusPath = options.StatusPath;
                    }
                }
                StatusSnapshot snapshot = TryLoadStatus(statusPath);
                bool opened = TopUpLauncher.Open(config, snapshot);
                return opened ? 0 : 1;
            }
            catch (Exception ex)
            {
                Log.Error("--open-balance 失败", ex);
                return 1;
            }
        }

        private static StatusSnapshot TryLoadStatus(string path)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path))
                {
                    return null;
                }
                string text = File.ReadAllText(path, Encoding.UTF8);
                if (text == null || text.Trim().Length == 0)
                {
                    return null;
                }
                Dictionary<string, object> root = JsonParser.Parse(text) as Dictionary<string, object>;
                if (root == null)
                {
                    return null;
                }
                return StatusSnapshot.FromJson(root);
            }
            catch
            {
                return null;
            }
        }
    }

    /// <summary>Node 状态引擎子进程守护（契约 §7）。</summary>
    internal sealed class AgentSupervisor : IDisposable
    {
        private const int RestartBackoffMs = 10000;
        // 带 BOM 的 UTF-8，便于 Windows 工具读取 agent.log 中的中文；仅在新建文件时写入 BOM。
        private static readonly UTF8Encoding Utf8Bom = new UTF8Encoding(true);

        private readonly string _nodePath;
        private readonly string _scriptPath;
        private readonly string _statusPath;
        private readonly string _logPath;
        private readonly string _workDir;
        private readonly int _intervalMs;
        private readonly bool _accountEnabled;
        private readonly object _gate = new object();
        private readonly object _logGate = new object();

        private Process _process;
        private int _lastStartTick;
        private bool _everStarted;
        private string _lastError;
        private string _lastArguments;
        private bool _disposed;

        public AgentSupervisor(string nodePath, string scriptPath, string statusPath, string logPath, int intervalMs, string workDir, bool accountEnabled)
        {
            _nodePath = nodePath;
            _scriptPath = scriptPath;
            _statusPath = statusPath;
            _logPath = logPath;
            _workDir = workDir;
            _accountEnabled = accountEnabled;
            if (intervalMs < 250)
            {
                intervalMs = 250;
            }
            _intervalMs = intervalMs;
        }

        /// <summary>最近一次启动使用的命令行参数（验收/排查用，不包含 token 等敏感信息）。</summary>
        public string LastArguments
        {
            get
            {
                lock (_gate)
                {
                    return _lastArguments;
                }
            }
        }

        public bool CanRun
        {
            get { return !string.IsNullOrEmpty(_nodePath) && !string.IsNullOrEmpty(_scriptPath); }
        }

        /// <summary>无法启动时的原因说明；可启动时为 null。</summary>
        public string Diagnostic
        {
            get
            {
                if (string.IsNullOrEmpty(_nodePath))
                {
                    return "未找到 node.exe，状态引擎无法启动";
                }
                if (string.IsNullOrEmpty(_scriptPath))
                {
                    return "未找到 src/status-agent.mjs，状态引擎无法启动";
                }
                return null;
            }
        }

        public string LastError
        {
            get
            {
                lock (_gate)
                {
                    return _lastError;
                }
            }
        }

        public bool IsRunning
        {
            get
            {
                lock (_gate)
                {
                    return IsRunningLocked();
                }
            }
        }

        public void Start()
        {
            lock (_gate)
            {
                if (!CanRun || _disposed)
                {
                    return;
                }
                StartLocked();
            }
        }

        /// <summary>
        /// 守护：进程退出后按 ≥10s 退避重启；心跳过期（status.json 超过 10s 未更新）时也按 ≥10s 间隔重启一次。
        /// </summary>
        public void EnsureRunning(bool heartbeatStale)
        {
            if (!CanRun || _disposed)
            {
                return;
            }
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
                if (!IsRunningLocked())
                {
                    if (!_everStarted || TimeUtil.ElapsedMs(_lastStartTick) >= RestartBackoffMs)
                    {
                        StartLocked();
                    }
                }
                else if (heartbeatStale && TimeUtil.ElapsedMs(_lastStartTick) >= RestartBackoffMs)
                {
                    StartLocked();
                }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
                _disposed = true;
                StopLocked();
            }
        }

        private bool IsRunningLocked()
        {
            try
            {
                return _process != null && !_process.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private void StartLocked()
        {
            StopLocked();
            _everStarted = true;
            _lastStartTick = Environment.TickCount;

            Process process = null;
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = _nodePath;
                string arguments = BuildArguments();
                _lastArguments = arguments;
                startInfo.Arguments = arguments;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.RedirectStandardInput = false;
                startInfo.WorkingDirectory = string.IsNullOrEmpty(_workDir) ? Path.GetTempPath() : _workDir;

                process = new Process();
                process.StartInfo = startInfo;
                process.OutputDataReceived += OnOutputData;
                process.ErrorDataReceived += OnErrorData;
                process.Start();
                _process = process;
                _lastError = null;
                AppendLog("# --- " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + " 启动状态引擎 pid=" + SafePid(process) + " ---");
                try
                {
                    process.BeginOutputReadLine();
                }
                catch (Exception ex)
                {
                    AppendLog("# 读取状态引擎 stdout 失败: " + ex.Message);
                }
                try
                {
                    process.BeginErrorReadLine();
                }
                catch (Exception ex)
                {
                    AppendLog("# 读取状态引擎 stderr 失败: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                if (process != null)
                {
                    try { process.Dispose(); }
                    catch { }
                }
                _process = null;
                AppendLog("# 启动状态引擎失败: " + ex.Message);
            }
        }

        private void StopLocked()
        {
            Process process = _process;
            _process = null;
            if (process == null)
            {
                return;
            }
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
            }
            catch
            {
            }
            try { process.WaitForExit(2000); }
            catch { }
            try { process.CancelOutputRead(); }
            catch { }
            try { process.CancelErrorRead(); }
            catch { }
            try { process.Dispose(); }
            catch { }
        }

        private string BuildArguments()
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(Quote(_scriptPath));
            builder.Append(" --out ").Append(Quote(_statusPath));
            builder.Append(" --interval ").Append(_intervalMs.ToString(CultureInfo.InvariantCulture));
            builder.Append(" --log ").Append(Quote(_logPath));
            if (_accountEnabled)
            {
                // account-balance-spec §4：showBalance=true 时让引擎查询余额。
                builder.Append(" --account");
            }
            return builder.ToString();
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                return "\"\"";
            }
            return "\"" + value + "\"";
        }

        private static string SafePid(Process process)
        {
            try
            {
                return process.Id.ToString(CultureInfo.InvariantCulture);
            }
            catch
            {
                return "?";
            }
        }

        private void OnOutputData(object sender, DataReceivedEventArgs e)
        {
            if (e == null || e.Data == null)
            {
                return;
            }
            AppendLog(e.Data);
        }

        private void OnErrorData(object sender, DataReceivedEventArgs e)
        {
            if (e == null || e.Data == null)
            {
                return;
            }
            AppendLog(e.Data);
        }

        /// <summary>追加写 agent.log（超过 1MB 轮转覆盖）；与状态引擎自身的 --log 写入共享文件，故用宽容共享模式。</summary>
        private void AppendLog(string line)
        {
            lock (_logGate)
            {
                try
                {
                    string dir = Path.GetDirectoryName(_logPath);
                    if (!string.IsNullOrEmpty(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }
                    RotateLog();
                    using (FileStream stream = new FileStream(_logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                    using (StreamWriter writer = new StreamWriter(stream, Utf8Bom))
                    {
                        writer.WriteLine(line);
                    }
                }
                catch
                {
                }
            }
        }

        private void RotateLog()
        {
            try
            {
                FileInfo info = new FileInfo(_logPath);
                if (info.Exists && info.Length > 1024 * 1024)
                {
                    File.Delete(_logPath);
                }
            }
            catch
            {
            }
        }
    }

    /// <summary>
    /// 进程内已通知 key 集合（alerts-spec §4.2）：HashSet 去重 + FIFO 上限淘汰。
    /// </summary>
    internal sealed class SeenKeySet
    {
        private readonly int _capacity;
        private readonly HashSet<string> _set;
        private readonly Queue<string> _order;

        public SeenKeySet(int capacity)
        {
            _capacity = capacity > 0 ? capacity : 100;
            _set = new HashSet<string>(StringComparer.Ordinal);
            _order = new Queue<string>();
        }

        public bool Contains(string key)
        {
            return !string.IsNullOrEmpty(key) && _set.Contains(key);
        }

        public void Add(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return;
            }
            if (!_set.Add(key))
            {
                return;
            }
            _order.Enqueue(key);
            while (_order.Count > _capacity)
            {
                string oldest = _order.Dequeue();
                _set.Remove(oldest);
            }
        }

        public int Count
        {
            get { return _set.Count; }
        }
    }

    /// <summary>托盘主体：NotifyIcon + 右键菜单 + 定时轮询。</summary>
    internal sealed class TrayApp : ApplicationContext
    {
        private const int StaleAfterMs = 10000;
        private const int StatusErrorLogEveryMs = 10000;
        private const int TooltipMaxLength = 60;
        private const int SeenKeyCapacity = 100;
        private const int SoundMinIntervalMs = 800;
        private const int BalloonTimeoutMs = 6000;
        private const int BalloonTextMaxLength = 120;

        private readonly AppConfig _config;
        private readonly string _statusPath;
        private readonly bool _noAgent;
        private readonly long _trayStartedAtMs;
        private readonly string _testNotifyKind;

        private NotifyIcon _notifyIcon;
        private ContextMenuStrip _contextMenu;
        private ToolStripMenuItem _balanceItem;
        private bool _balanceItemShown;
        private System.Windows.Forms.Timer _timer;
        private System.Windows.Forms.Timer _testNotifyTimer;
        private System.Windows.Forms.Timer _testExitTimer;
        private AgentSupervisor _agent;

        private Icon _icon;
        private IntPtr _iconHandle = IntPtr.Zero;
        private string _iconKey;

        private StatusSnapshot _lastSnapshot;
        private string _lastTooltip;
        private int _lastStatusErrorTick = Environment.TickCount - 60000;
        private bool _shutdown;

        private readonly SeenKeySet _seenCompletionKeys = new SeenKeySet(SeenKeyCapacity);
        private readonly SeenKeySet _seenAttentionKeys = new SeenKeySet(SeenKeyCapacity);
        private SoundPlayer _soundPlayer;
        private string _soundPlayerPath;
        private int _lastSoundTick = Environment.TickCount - SoundMinIntervalMs;

        public TrayApp(Options options, AppConfig config, string dataDir)
            : this(options, config, dataDir, null)
        {
        }

        public TrayApp(Options options, AppConfig config, string dataDir, string testNotifyKind)
        {
            _config = config;
            _testNotifyKind = testNotifyKind;
            _noAgent = options.NoAgent || !string.IsNullOrEmpty(testNotifyKind);
            _trayStartedAtMs = TimeUtil.NowEpochMs();

            string statusPath = options.StatusPath;
            if (string.IsNullOrEmpty(statusPath))
            {
                statusPath = Path.Combine(dataDir, "status.json");
            }
            else
            {
                try
                {
                    statusPath = Path.GetFullPath(statusPath);
                }
                catch
                {
                }
            }
            _statusPath = statusPath;

            CreateMenu();
            CreateNotifyIcon();

            if (!_noAgent)
            {
                StartAgent(Path.Combine(dataDir, "agent.log"), dataDir);
            }

            int interval = _config.PollMs;
            if (interval < 250)
            {
                interval = 250;
            }
            if (interval > 10000)
            {
                interval = 10000;
            }
            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = interval;
            _timer.Tick += OnTimerTick;
            _timer.Start();

            if (!string.IsNullOrEmpty(_testNotifyKind))
            {
                SetupTestNotify();
            }
            else
            {
                TickOnce();
            }
        }

        // ---------- 初始化 ----------

        private void CreateMenu()
        {
            ToolStripMenuItem openConsoleItem;
            ToolStripMenuItem balanceItem;
            ToolStripMenuItem exitItem;
            _contextMenu = BuildContextMenu(OnOpenConsoleClick, OnBalanceClick, OnExitClick,
                out openConsoleItem, out balanceItem, out exitItem);
            _balanceItem = balanceItem;
            // v3：充值余额项（account-balance-spec §5.2），位于「打开控制台」之后、分隔线/「退出」之前。
            _balanceItem.Visible = _config.ShowBalance;
            // 先用 true 占位：若 showBalance=false，首次 UpdateBalanceItem 会补一条"隐藏"日志，便于验收。
            _balanceItemShown = true;
            _contextMenu.Opening += OnMenuOpening;
            Log.Info("右键菜单项: " + DescribeMenuItems(_contextMenu));
        }

        /// <summary>
        /// 构建右键菜单（state-model-v5 §2.3）：只有操作项，不再有状态行/权限行。
        /// 顺序：打开控制台、充值余额、分隔线、退出。抽成静态方法便于自测校验结构。
        /// </summary>
        internal static ContextMenuStrip BuildContextMenu(EventHandler onOpenConsole, EventHandler onBalance, EventHandler onExit,
            out ToolStripMenuItem openConsoleItem, out ToolStripMenuItem balanceItem, out ToolStripMenuItem exitItem)
        {
            openConsoleItem = new ToolStripMenuItem("打开控制台");
            if (onOpenConsole != null)
            {
                openConsoleItem.Click += onOpenConsole;
            }

            balanceItem = new ToolStripMenuItem("充值余额：未登录");
            if (onBalance != null)
            {
                balanceItem.Click += onBalance;
            }

            ToolStripSeparator separator = new ToolStripSeparator();

            exitItem = new ToolStripMenuItem("退出");
            if (onExit != null)
            {
                exitItem.Click += onExit;
            }

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(openConsoleItem);
            menu.Items.Add(balanceItem);
            menu.Items.Add(separator);
            menu.Items.Add(exitItem);
            return menu;
        }

        internal static string DescribeMenuItems(ContextMenuStrip menu)
        {
            if (menu == null)
            {
                return string.Empty;
            }
            List<string> parts = new List<string>();
            for (int i = 0; i < menu.Items.Count; i++)
            {
                ToolStripItem item = menu.Items[i];
                if (item is ToolStripSeparator)
                {
                    parts.Add("---");
                }
                else
                {
                    parts.Add(item.Text);
                }
            }
            return string.Join(" | ", parts.ToArray());
        }

        private void CreateNotifyIcon()
        {
            _notifyIcon = new NotifyIcon();
            _notifyIcon.ContextMenuStrip = _contextMenu;
            _notifyIcon.DoubleClick += OnNotifyIconDoubleClick;
            ApplyTooltip("状态监视器启动中");
            SetIcon(_config.GetColor("idle"));
            _notifyIcon.Visible = true;
        }

        // ---------- v2：气泡通知 + 提示音（alerts-spec §4） ----------

        /// <summary>
        /// --test-notify：400ms 后（等 Shell 注册好图标）用假数据走真实通知代码路径，
        /// 5 秒后 Environment.Exit(0)（留出验收截图时间）。
        /// </summary>
        private void SetupTestNotify()
        {
            Log.Info("--test-notify 启动: " + _testNotifyKind);
            _testNotifyTimer = new System.Windows.Forms.Timer();
            _testNotifyTimer.Interval = 400;
            _testNotifyTimer.Tick += OnTestNotifyTick;
            _testNotifyTimer.Start();

            _testExitTimer = new System.Windows.Forms.Timer();
            _testExitTimer.Interval = 5000;
            _testExitTimer.Tick += OnTestExitTick;
            _testExitTimer.Start();
        }

        private void OnTestNotifyTick(object sender, EventArgs e)
        {
            try
            {
                if (_testNotifyTimer != null)
                {
                    _testNotifyTimer.Stop();
                    _testNotifyTimer.Tick -= OnTestNotifyTick;
                    _testNotifyTimer.Dispose();
                    _testNotifyTimer = null;
                }
                TriggerTestNotification(_testNotifyKind);
            }
            catch (Exception ex)
            {
                Log.Error("--test-notify 触发失败", ex);
            }
        }

        private void OnTestExitTick(object sender, EventArgs e)
        {
            try
            {
                if (_testExitTimer != null)
                {
                    _testExitTimer.Stop();
                    _testExitTimer.Tick -= OnTestExitTick;
                    _testExitTimer.Dispose();
                    _testExitTimer = null;
                }
            }
            catch
            {
            }
            Shutdown();
            Environment.Exit(0);
        }

        private void TriggerTestNotification(string kind)
        {
            long now = TimeUtil.NowEpochMs();
            StatusSnapshot fake = new StatusSnapshot();
            fake.GeneratedAt = now;
            fake.State = "approval";
            fake.StateLabel = "需要审批";
            if (string.Equals(kind, "completion", StringComparison.OrdinalIgnoreCase))
            {
                fake.State = "idle";
                CompletionAlert completion = new CompletionAlert();
                completion.Key = "test:completion:" + now.ToString(CultureInfo.InvariantCulture);
                completion.At = now;
                completion.SessionId = "session-test";
                completion.Title = "示例项目 A";
                completion.Main = true;
                fake.Completion = completion;
            }
            else
            {
                AttentionAlert attention = new AttentionAlert();
                attention.Key = "test:attention:" + now.ToString(CultureInfo.InvariantCulture);
                attention.Kind = "approval";
                attention.At = now;
                attention.ToolName = "pwsh";
                attention.SessionId = "session-test";
                attention.Title = "示例项目 A";
                attention.Main = true;
                attention.PendingCount = 1;
                fake.Attention = attention;
            }
            ProcessAlertNotifications(fake, false);
        }

        /// <summary>真实 tick 与 --test-notify 共用的通知判定：key 去重 + at/state 条件 + 同 tick 只播一次声音。</summary>
        private void ProcessAlertNotifications(StatusSnapshot snapshot, bool stale)
        {
            if (stale || snapshot == null)
            {
                return;
            }
            bool notified = false;
            // 调试/验收模式下即使 config 关闭通知也要能演示真实路径。
            bool notifyCompletion = _config.NotifyCompletion || !string.IsNullOrEmpty(_testNotifyKind);
            bool notifyApproval = _config.NotifyApproval || !string.IsNullOrEmpty(_testNotifyKind);

            if (notifyCompletion && snapshot.Completion != null
                && !string.IsNullOrEmpty(snapshot.Completion.Key)
                && snapshot.Completion.At >= _trayStartedAtMs
                && !_seenCompletionKeys.Contains(snapshot.Completion.Key))
            {
                _seenCompletionKeys.Add(snapshot.Completion.Key);
                NotifyCompletion(snapshot.Completion);
                notified = true;
            }

            if (notifyApproval && snapshot.State == "approval" && snapshot.Attention != null
                && !string.IsNullOrEmpty(snapshot.Attention.Key)
                && !_seenAttentionKeys.Contains(snapshot.Attention.Key))
            {
                _seenAttentionKeys.Add(snapshot.Attention.Key);
                NotifyAttention(snapshot.Attention);
                notified = true;
            }

            if (notified)
            {
                PlayAlertSound();
            }
        }

        private void NotifyCompletion(CompletionAlert alert)
        {
            string sessionTitle = alert == null ? null : alert.Title;
            string text = BuildCompletionText(sessionTitle);
            ShowBalloon("任务完成", text, ToolTipIcon.Info);
            Log.Info("气泡通知(完成): " + text);
        }

        private void NotifyAttention(AttentionAlert alert)
        {
            if (alert == null)
            {
                return;
            }
            if (string.Equals(alert.Kind, "question", StringComparison.OrdinalIgnoreCase))
            {
                string questionText = BuildQuestionText(alert.PendingCount, alert.Title);
                ShowBalloon("需要你回答", questionText, ToolTipIcon.Warning);
                Log.Info("气泡通知(问题): " + questionText);
            }
            else
            {
                string approvalText = BuildApprovalText(alert.ToolName, alert.Title);
                ShowBalloon("需要审批", approvalText, ToolTipIcon.Warning);
                Log.Info("气泡通知(审批): " + approvalText);
            }
        }

        private void ShowBalloon(string title, string text, ToolTipIcon icon)
        {
            try
            {
                if (_notifyIcon != null)
                {
                    _notifyIcon.ShowBalloonTip(BalloonTimeoutMs, title, text, icon);
                }
            }
            catch (Exception ex)
            {
                Log.Error("弹出气泡通知失败", ex);
            }
        }

        internal static string BuildCompletionText(string sessionTitle)
        {
            string title = TrimToSingleLine(sessionTitle);
            string text = title.Length == 0 ? "DSH 已完成本轮任务" : "「" + title + "」已完成本轮任务";
            return TruncateBalloonText(text);
        }

        internal static string BuildApprovalText(string toolName, string sessionTitle)
        {
            string text = string.IsNullOrEmpty(toolName)
                ? "有操作在等你批准"
                : "有操作在等你批准：" + TrimToSingleLine(toolName);
            string title = TrimToSingleLine(sessionTitle);
            if (title.Length > 0)
            {
                text += " · " + title;
            }
            return TruncateBalloonText(text);
        }

        internal static string BuildQuestionText(int pendingCount, string sessionTitle)
        {
            int count = pendingCount > 0 ? pendingCount : 1;
            string text = "有 " + count.ToString(CultureInfo.InvariantCulture) + " 个问题待回答";
            string title = TrimToSingleLine(sessionTitle);
            if (title.Length > 0)
            {
                text += " · " + title;
            }
            return TruncateBalloonText(text);
        }

        private static string TrimToSingleLine(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return string.Empty;
            }
            return raw.Replace("\r\n", " ").Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim();
        }

        private static string TruncateBalloonText(string text)
        {
            string single = TrimToSingleLine(text);
            if (single.Length <= BalloonTextMaxLength)
            {
                return single;
            }
            single = single.Substring(0, BalloonTextMaxLength - 1);
            if (single.Length > 0 && char.IsHighSurrogate(single[single.Length - 1]))
            {
                single = single.Substring(0, single.Length - 1);
            }
            return single.TrimEnd() + "…";
        }

        /// <summary>播放提示音：懒加载缓存 SoundPlayer；失败回退系统提示音；两次之间至少 800ms。</summary>
        private void PlayAlertSound()
        {
            if (!_config.PlaySound && string.IsNullOrEmpty(_testNotifyKind))
            {
                return;
            }
            if (TimeUtil.ElapsedMs(_lastSoundTick) < SoundMinIntervalMs)
            {
                return;
            }
            _lastSoundTick = Environment.TickCount;

            string path = ResolveSoundPath(_config.SoundFile);
            if (path.Length == 0)
            {
                // soundFile 未配置：直接使用系统提示音，不构造 SoundPlayer。
                Log.Info("播放系统提示音（未配置 soundFile）");
                try
                {
                    SystemSounds.Exclamation.Play();
                }
                catch (Exception fallbackEx)
                {
                    Log.Error("播放系统提示音失败", fallbackEx);
                }
                return;
            }
            Log.Info("播放提示音: " + path);
            try
            {
                if (_soundPlayer == null || !string.Equals(_soundPlayerPath, path, StringComparison.OrdinalIgnoreCase))
                {
                    if (_soundPlayer != null)
                    {
                        try { _soundPlayer.Dispose(); }
                        catch { }
                        _soundPlayer = null;
                        _soundPlayerPath = null;
                    }
                    SoundPlayer player = new SoundPlayer(path);
                    player.Load();
                    _soundPlayer = player;
                    _soundPlayerPath = path;
                }
                _soundPlayer.Play();
            }
            catch (Exception ex)
            {
                Log.Error("播放提示音失败，回退系统提示音: " + path, ex);
                try
                {
                    SystemSounds.Exclamation.Play();
                }
                catch (Exception fallbackEx)
                {
                    Log.Error("播放系统提示音失败", fallbackEx);
                }
            }
        }

        /// <summary>soundFile 支持绝对路径、相对路径（相对 exe 目录）；留空表示使用系统提示音。</summary>
        internal static string ResolveSoundPath(string configured)
        {
            string value = configured;
            if (string.IsNullOrEmpty(value) || value.Trim().Length == 0)
            {
                value = AppConfig.DefaultSoundFile;
            }
            value = value.Trim();
            if (value.Length == 0)
            {
                return string.Empty; // 未配置 → 使用系统默认提示音
            }
            try
            {
                if (Path.IsPathRooted(value))
                {
                    return value;
                }
                string baseDir = Paths.AppBaseDir;
                if (string.IsNullOrEmpty(baseDir))
                {
                    baseDir = Paths.ProjectDir;
                }
                return Path.GetFullPath(Path.Combine(baseDir, value));
            }
            catch
            {
                return value;
            }
        }

        private void StartAgent(string agentLogPath, string dataDir)
        {
            try
            {
                string nodePath = Paths.FindNodeExe();
                string scriptPath = Paths.FindAgentScript();
                _agent = new AgentSupervisor(nodePath, scriptPath, _statusPath, agentLogPath, _config.PollMs, dataDir, _config.ShowBalance);
                if (_agent.CanRun)
                {
                    _agent.Start();
                    Log.Info("状态引擎已启动: " + scriptPath);
                    Log.Info("状态引擎参数: " + _agent.LastArguments);
                }
                else
                {
                    Log.Info("状态引擎不可用: " + _agent.Diagnostic);
                }
            }
            catch (Exception ex)
            {
                Log.Error("启动状态引擎失败", ex);
            }
        }

        // ---------- 定时轮询 ----------

        private void OnTimerTick(object sender, EventArgs e)
        {
            if (_shutdown)
            {
                return;
            }
            try
            {
                TickOnce();
            }
            catch (Exception ex)
            {
                Log.Error("托盘定时刷新失败", ex);
            }
        }

        private void TickOnce()
        {
            long nowMs = TimeUtil.NowEpochMs();
            StatusSnapshot snapshot = null;
            try
            {
                snapshot = ReadStatusSnapshot();
            }
            catch (Exception ex)
            {
                LogStatusError("读取 status.json 失败", ex);
            }

            if (snapshot != null)
            {
                _lastSnapshot = snapshot;
            }

            bool stale;
            if (_lastSnapshot == null)
            {
                stale = true;
            }
            else
            {
                long age = nowMs - _lastSnapshot.GeneratedAt;
                stale = age > StaleAfterMs;
            }

            ApplyStatus(stale);
            SuperviseAgent(stale);
            UpdateBalanceItem();
            ProcessAlertNotifications(_lastSnapshot, stale);
        }

        private StatusSnapshot ReadStatusSnapshot()
        {
            try
            {
                if (!File.Exists(_statusPath))
                {
                    return null;
                }
                string text;
                using (FileStream stream = new FileStream(_statusPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (stream.Length == 0)
                    {
                        return null;
                    }
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
                    {
                        text = reader.ReadToEnd();
                    }
                }
                if (text == null || text.Trim().Length == 0)
                {
                    return null;
                }

                object parsed;
                try
                {
                    parsed = JsonParser.Parse(text);
                }
                catch (Exception ex)
                {
                    // 原子写入期间理论上读不到半文件，但保持容错：保留上一次状态。
                    LogStatusError("status.json 不是合法 JSON", ex);
                    return null;
                }
                Dictionary<string, object> root = parsed as Dictionary<string, object>;
                if (root == null)
                {
                    return null;
                }
                StatusSnapshot snapshot = StatusSnapshot.FromJson(root);
                if (snapshot.GeneratedAt <= 0)
                {
                    try
                    {
                        snapshot.GeneratedAt = TimeUtil.EpochMs(File.GetLastWriteTimeUtc(_statusPath));
                    }
                    catch
                    {
                    }
                }
                return snapshot;
            }
            catch (IOException)
            {
                // 文件正在被原子替换/删除：保留上一次状态。
                return null;
            }
            catch (UnauthorizedAccessException ex)
            {
                LogStatusError("无权读取 status.json", ex);
                return null;
            }
            catch (Exception ex)
            {
                LogStatusError("读取 status.json 失败", ex);
                return null;
            }
        }

        private void LogStatusError(string message, Exception exception)
        {
            if (TimeUtil.ElapsedMs(_lastStatusErrorTick) < StatusErrorLogEveryMs)
            {
                return;
            }
            _lastStatusErrorTick = Environment.TickCount;
            if (exception == null)
            {
                Log.ErrorText(message);
            }
            else
            {
                Log.Error(message, exception);
            }
        }

        private void SuperviseAgent(bool stale)
        {
            if (_noAgent || _agent == null)
            {
                return;
            }
            try
            {
                _agent.EnsureRunning(stale);
            }
            catch (Exception ex)
            {
                Log.Error("守护状态引擎失败", ex);
            }
        }

        // ---------- UI 更新 ----------

        /// <summary>stale（状态监视器未响应）兜底图标颜色：v5 起用 offline 灰（state-model-v5 §2.2）。</summary>
        internal static Color GetStaleIconColor(AppConfig config)
        {
            return config == null ? Color.FromArgb(154, 160, 166) : config.GetColor("offline");
        }

        private void ApplyStatus(bool stale)
        {
            if (stale)
            {
                SetIcon(GetStaleIconColor(_config));
                ApplyTooltip("状态监视器未响应");
                return;
            }

            StatusSnapshot snapshot = _lastSnapshot;
            SetIcon(_config.GetColor(snapshot.State));
            string tooltip = snapshot.Tooltip;
            if (string.IsNullOrEmpty(tooltip))
            {
                tooltip = BuildTooltipFallback(snapshot);
            }
            ApplyTooltip(tooltip);
        }

        /// <summary>只有图标颜色变化时才重建 HICON；旧 HICON 用 DestroyIcon 释放。</summary>
        private void SetIcon(Color color)
        {
            string key = color.ToArgb().ToString(CultureInfo.InvariantCulture);
            if (_notifyIcon != null && _notifyIcon.Icon != null
                && string.Equals(key, _iconKey, StringComparison.Ordinal))
            {
                return;
            }

            IntPtr handle = IntPtr.Zero;
            Icon icon = null;
            try
            {
                using (Bitmap bitmap = IconPainter.CreateBitmap(color))
                {
                    handle = bitmap.GetHicon();
                }
                icon = Icon.FromHandle(handle);
                if (_notifyIcon != null)
                {
                    _notifyIcon.Icon = icon;
                }

                Icon oldIcon = _icon;
                IntPtr oldHandle = _iconHandle;
                _icon = icon;
                _iconHandle = handle;
                _iconKey = key;
                icon = null;
                handle = IntPtr.Zero;
                Log.Info("托盘图标颜色: " + ColorToHex(color));

                if (oldIcon != null)
                {
                    try { oldIcon.Dispose(); }
                    catch { }
                }
                if (oldHandle != IntPtr.Zero)
                {
                    try { NativeMethods.DestroyIcon(oldHandle); }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                Log.Error("更新托盘图标失败", ex);
            }
            finally
            {
                if (icon != null)
                {
                    try { icon.Dispose(); }
                    catch { }
                }
                if (handle != IntPtr.Zero)
                {
                    try { NativeMethods.DestroyIcon(handle); }
                    catch { }
                }
            }
        }

        internal static string ColorToHex(Color color)
        {
            return "#" + color.R.ToString("X2", CultureInfo.InvariantCulture)
                + color.G.ToString("X2", CultureInfo.InvariantCulture)
                + color.B.ToString("X2", CultureInfo.InvariantCulture);
        }

        private static string BuildTooltipFallback(StatusSnapshot snapshot)
        {
            string label = string.IsNullOrEmpty(snapshot.StateLabel) ? snapshot.State : snapshot.StateLabel;
            if (!string.IsNullOrEmpty(snapshot.SessionTitle))
            {
                return "状态：" + label + " · " + snapshot.SessionTitle;
            }
            return "状态：" + label;
        }

        private void ApplyTooltip(string raw)
        {
            string text = NormalizeTooltip(raw);
            if (string.IsNullOrEmpty(text))
            {
                text = "DSH 状态托盘";
            }
            if (string.Equals(text, _lastTooltip, StringComparison.Ordinal))
            {
                return;
            }
            _lastTooltip = text;
            // 验收辅助日志：多行用 \n 转义记录，便于确认换行被保留
            Log.Info(text.IndexOf('\n') >= 0 ? "托盘提示(多行): " + text.Replace("\n", "\\n") : "托盘提示: " + text);
            try
            {
                if (_notifyIcon != null)
                {
                    _notifyIcon.Text = text;
                }
            }
            catch (Exception ex)
            {
                Log.Error("设置托盘提示文本失败", ex);
            }
        }

        /// <summary>
        /// 规范化托盘提示（working-sessions-spec §3）：保留换行、逐行清理、总字符 ≤60（NotifyIcon.Text 硬限 63）。
        /// 规则：\r\n/\r → \n；逐行去首尾空白并把连续空白折叠成单空格；丢弃空行；超出预算时从最后一行截断加"…"，
        /// 仍超则丢弃后面整行并补"…"。保证返回 ≤60 字符且不含 '\r'。
        /// </summary>
        internal static string NormalizeTooltip(string raw)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return string.Empty;
            }

            // 1) 统一换行为 \n，逐行清理（trim + 空白折叠 + 丢弃空行）
            string unified = raw.Replace("\r\n", "\n").Replace('\r', '\n');
            string[] rawLines = unified.Split(new char[] { '\n' }, StringSplitOptions.None);
            List<string> lines = new List<string>();
            for (int i = 0; i < rawLines.Length; i++)
            {
                string line = CollapseTooltipLine(rawLines[i]);
                if (line.Length > 0)
                {
                    lines.Add(line);
                }
            }
            if (lines.Count == 0)
            {
                return string.Empty;
            }

            // 2) 未超预算：保留多行原样返回（单行行为与旧版一致，只是不再把换行压成空格）
            string joined = JoinTooltipLines(lines);
            if (joined.Length <= TooltipMaxLength)
            {
                return joined;
            }

            // 3) 超预算：优先保留前面整行 + 截断最后一行加"…"；仍放不下则丢弃后面的整行
            for (int lineCount = lines.Count; lineCount >= 1; lineCount--)
            {
                List<string> prefix = lines.GetRange(0, lineCount - 1);
                string prefixText = JoinTooltipLines(prefix);
                int prefixCost = prefixText.Length > 0 ? prefixText.Length + 1 : 0; // 行间 '\n'
                int budget = TooltipMaxLength - prefixCost - 1; // 预留末尾 '…'
                if (budget < 1)
                {
                    continue;
                }
                string last = lines[lineCount - 1];
                if (last.Length > budget)
                {
                    prefix.Add(SafeSubstring(last, budget) + "…");
                    return JoinTooltipLines(prefix);
                }
                // 理论上不会走到这里（若最后一行放得下，总长必然 ≤ 预算），继续丢弃本行更安全
            }

            // 兜底（理论上不可达）：只保留首行并截断
            return SafeSubstring(lines[0], TooltipMaxLength - 1) + "…";
        }

        /// <summary>单行清理：去首尾空白，连续空白（空格/制表等）折叠为单空格。</summary>
        private static string CollapseTooltipLine(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }
            StringBuilder builder = new StringBuilder(value.Length);
            bool pendingSpace = false;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (char.IsWhiteSpace(c))
                {
                    if (builder.Length > 0)
                    {
                        pendingSpace = true;
                    }
                    continue;
                }
                if (pendingSpace)
                {
                    builder.Append(' ');
                    pendingSpace = false;
                }
                builder.Append(c);
            }
            return builder.ToString();
        }

        private static string JoinTooltipLines(List<string> lines)
        {
            if (lines == null || lines.Count == 0)
            {
                return string.Empty;
            }
            if (lines.Count == 1)
            {
                return lines[0] == null ? string.Empty : lines[0];
            }
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < lines.Count; i++)
            {
                if (i > 0)
                {
                    builder.Append('\n');
                }
                if (lines[i] != null)
                {
                    builder.Append(lines[i]);
                }
            }
            return builder.ToString();
        }

        /// <summary>按 UTF-16 长度安全截断（不切断代理对）。</summary>
        private static string SafeSubstring(string value, int maxLength)
        {
            if (string.IsNullOrEmpty(value) || maxLength <= 0)
            {
                return string.Empty;
            }
            if (value.Length <= maxLength)
            {
                return value;
            }
            string result = value.Substring(0, maxLength);
            if (result.Length > 0 && char.IsHighSurrogate(result[result.Length - 1]))
            {
                result = result.Substring(0, result.Length - 1);
            }
            return result;
        }

        // ---------- v3：充值余额菜单项（account-balance-spec §5） ----------

        /// <summary>按最新快照刷新余额菜单项文字/提示（菜单 Opening 与每个 tick 都会走到这里）。</summary>
        private void UpdateBalanceItem()
        {
            if (_balanceItem == null)
            {
                return;
            }
            bool visible = _config.ShowBalance;
            if (_balanceItemShown != visible)
            {
                // 注意：ContextMenuStrip 未弹出时 ToolStripItem.Visible 的 getter 会返回 false，
                // 因此用独立字段记录期望可见性，避免每个 tick 重复赋值/刷日志。
                _balanceItemShown = visible;
                _balanceItem.Visible = visible;
                Log.Info("余额菜单项: " + (visible ? "显示" : "隐藏（showBalance=false）"));
            }
            if (!visible)
            {
                return;
            }

            AccountInfo account = _lastSnapshot == null ? null : _lastSnapshot.Account;
            string text = BuildBalanceMenuText(account);
            if (!string.Equals(_balanceItem.Text, text, StringComparison.Ordinal))
            {
                _balanceItem.Text = text;
                // 供自动化验收核对菜单文字（不影响既有功能）
                Log.Info("余额菜单文字: " + text);
            }
            string tooltip = BuildBalanceTooltip(account);
            if (!string.Equals(_balanceItem.ToolTipText, tooltip, StringComparison.Ordinal))
            {
                _balanceItem.ToolTipText = tooltip;
            }
        }

        /// <summary>菜单项文字（account-balance-spec §5.2）；account 为 null 表示 status.json 无 account 字段（未登录）。</summary>
        internal static string BuildBalanceMenuText(AccountInfo account)
        {
            if (account == null)
            {
                return "充值余额：未登录";
            }
            string status = NormalizeAccountToken(account.Status);
            if (status == "ready")
            {
                string money = FormatMoney(account.Balance, account.Currency);
                return money == null ? "充值余额：获取失败" : "充值余额：" + money;
            }
            if (status == "loading")
            {
                return "充值余额：获取中…";
            }
            if (status == "error")
            {
                string error = NormalizeAccountToken(account.Error);
                if (error == "auth")
                {
                    return "充值余额：登录已过期";
                }
                if (error == "network" || error == "protocol")
                {
                    return "充值余额：获取失败";
                }
                return "充值余额：未登录";
            }
            // unavailable / 未知状态 / 空对象 → 未登录
            return "充值余额：未登录";
        }

        /// <summary>菜单项 hover 提示：赠送余额 + 更新时间（account-balance-spec §5.4；可为空）。</summary>
        internal static string BuildBalanceTooltip(AccountInfo account)
        {
            if (account == null)
            {
                return string.Empty;
            }
            string status = NormalizeAccountToken(account.Status);
            if (status == "ready")
            {
                string bonus = FormatMoney(account.BonusBalance, account.Currency);
                string time = TimeUtil.FormatLocalTime(account.FetchedAt, "HH:mm");
                if (bonus != null && time.Length > 0)
                {
                    return "赠送余额：" + bonus + " · " + time + " 更新";
                }
                if (bonus != null)
                {
                    return "赠送余额：" + bonus;
                }
                if (time.Length > 0)
                {
                    return time + " 更新";
                }
                return string.Empty;
            }
            if (status == "loading")
            {
                return "正在获取账户余额…";
            }
            if (status == "error")
            {
                string error = NormalizeAccountToken(account.Error);
                if (error == "auth")
                {
                    return "登录已过期，请在 DSH 中重新登录后自动刷新";
                }
                if (error == "network" || error == "protocol")
                {
                    return "获取失败，稍后自动重试";
                }
                return string.Empty;
            }
            return string.Empty;
        }

        /// <summary>格式化金额：CNY→¥、USD→$，保留 2 位小数；非法数字返回 null。</summary>
        internal static string FormatMoney(string rawBalance, string currency)
        {
            if (rawBalance == null || rawBalance.Trim().Length == 0)
            {
                return null;
            }
            decimal value;
            if (!decimal.TryParse(rawBalance.Trim(), NumberStyles.Number, CultureInfo.InvariantCulture, out value))
            {
                return null;
            }
            string symbol;
            string currencyToken = currency == null ? string.Empty : currency.Trim();
            if (string.Equals(currencyToken, "CNY", StringComparison.OrdinalIgnoreCase))
            {
                symbol = "¥";
            }
            else if (string.Equals(currencyToken, "USD", StringComparison.OrdinalIgnoreCase))
            {
                symbol = "$";
            }
            else if (currencyToken.Length > 0)
            {
                symbol = currencyToken + " ";
            }
            else
            {
                symbol = string.Empty;
            }
            return symbol + value.ToString("0.00", CultureInfo.InvariantCulture);
        }

        private static string NormalizeAccountToken(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }
            string token = value.Trim().ToLowerInvariant();
            return token;
        }

        // ---------- 交互 ----------

        private void OnBalanceClick(object sender, EventArgs e)
        {
            try
            {
                TopUpLauncher.Open(_config, _lastSnapshot);
            }
            catch (Exception ex)
            {
                Log.Error("打开充值页失败", ex);
            }
        }

        private void OnMenuOpening(object sender, CancelEventArgs e)
        {
            try
            {
                // v5：菜单只保留操作项，Opening 仍按最新快照刷新余额项
                UpdateBalanceItem();
            }
            catch (Exception ex)
            {
                Log.Error("刷新菜单余额项失败", ex);
            }
        }

        private void OnOpenConsoleClick(object sender, EventArgs e)
        {
            try
            {
                ConsoleLauncher.Open(_config.ConsoleUrl);
            }
            catch (Exception ex)
            {
                Log.Error("打开控制台失败", ex);
            }
        }

        private void OnNotifyIconDoubleClick(object sender, EventArgs e)
        {
            OnOpenConsoleClick(sender, e);
        }

        private void OnExitClick(object sender, EventArgs e)
        {
            if (_shutdown)
            {
                return;
            }
            try
            {
                Log.Info("用户点击退出");
            }
            catch
            {
            }
            Shutdown();
            ExitThread();
        }

        // ---------- 收尾 ----------

        public void Shutdown()
        {
            if (_shutdown)
            {
                return;
            }
            _shutdown = true;

            try
            {
                if (_timer != null)
                {
                    _timer.Stop();
                    _timer.Tick -= OnTimerTick;
                    _timer.Dispose();
                    _timer = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("释放轮询 Timer 失败", ex);
            }

            try
            {
                if (_testNotifyTimer != null)
                {
                    _testNotifyTimer.Stop();
                    _testNotifyTimer.Dispose();
                    _testNotifyTimer = null;
                }
                if (_testExitTimer != null)
                {
                    _testExitTimer.Stop();
                    _testExitTimer.Dispose();
                    _testExitTimer = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("释放 --test-notify Timer 失败", ex);
            }

            try
            {
                if (_soundPlayer != null)
                {
                    _soundPlayer.Dispose();
                    _soundPlayer = null;
                    _soundPlayerPath = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("释放提示音播放器失败", ex);
            }

            try
            {
                if (_agent != null)
                {
                    _agent.Dispose();
                    _agent = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("停止状态引擎失败", ex);
            }

            try
            {
                if (_notifyIcon != null)
                {
                    _notifyIcon.Visible = false;
                }
            }
            catch (Exception ex)
            {
                Log.Error("隐藏托盘图标失败", ex);
            }

            try
            {
                if (_notifyIcon != null)
                {
                    _notifyIcon.ContextMenuStrip = null;
                    _notifyIcon.DoubleClick -= OnNotifyIconDoubleClick;
                    _notifyIcon.Dispose();
                    _notifyIcon = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("释放 NotifyIcon 失败", ex);
            }

            try
            {
                if (_contextMenu != null)
                {
                    _contextMenu.Dispose();
                    _contextMenu = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("释放右键菜单失败", ex);
            }

            try
            {
                if (_icon != null)
                {
                    _icon.Dispose();
                    _icon = null;
                }
            }
            catch (Exception ex)
            {
                Log.Error("释放图标对象失败", ex);
            }

            if (_iconHandle != IntPtr.Zero)
            {
                try { NativeMethods.DestroyIcon(_iconHandle); }
                catch { }
                _iconHandle = IntPtr.Zero;
            }

            Log.Info("托盘已退出");
        }
    }
}
