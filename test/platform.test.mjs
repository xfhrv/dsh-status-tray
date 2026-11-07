/**
 * 平台相关路径测试：status-agent.mjs 的默认运行时目录必须与托盘程序一致。
 * Windows 版保持 %LOCALAPPDATA%\DSHStatusTray；macOS 版用 ~/Library/Application Support/DSHStatusTray。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { runtimeDir } from '../src/status-agent.mjs';

test('runtimeDir(darwin): ~/Library/Application Support/DSHStatusTray', () => {
  assert.equal(
    runtimeDir('darwin'),
    path.join(os.homedir(), 'Library', 'Application Support', 'DSHStatusTray'),
  );
});

test('runtimeDir(win32): 优先 LOCALAPPDATA，缺失时回退 ~/AppData/Local', () => {
  const previous = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = path.join(path.sep, 'tmp', 'DshLocalAppData');
    assert.equal(runtimeDir('win32'), path.join(path.sep, 'tmp', 'DshLocalAppData', 'DSHStatusTray'));

    delete process.env.LOCALAPPDATA;
    assert.equal(runtimeDir('win32'), path.join(os.homedir(), 'AppData', 'Local', 'DSHStatusTray'));
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});

test('runtimeDir(linux): 使用 XDG_STATE_HOME，缺失时回退 ~/.local/state', () => {
  const previous = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = path.join(path.sep, 'tmp', 'dsh-state');
    assert.equal(runtimeDir('linux'), path.join(path.sep, 'tmp', 'dsh-state', 'DSHStatusTray'));

    delete process.env.XDG_STATE_HOME;
    assert.equal(
      runtimeDir('linux'),
      path.join(os.homedir(), '.local', 'state', 'DSHStatusTray'),
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});
