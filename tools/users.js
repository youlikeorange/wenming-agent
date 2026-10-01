#!/usr/bin/env node
/**
 * tools/users.js —— 独立运行时的账号管理（增 / 改密 / 列表）
 *
 *   node tools/users.js list
 *   node tools/users.js add <名字> [密码] [--admin]
 *   node tools/users.js passwd <名字> [密码]
 *
 * 为什么需要它：账号存在 STATE_DIR/permissions.json，而**建账号的界面在文档站里**
 * （/api/permissions，文档站的权限页）。独立运行没有那个界面，这个脚本就是替代品；
 * 密码的存储格式与校验逻辑（scrypt + salt）与站点完全一致，两边可以互认。
 *
 * 省略密码 = 自动生成随机密码并打印（只显示这一次）。
 * 数据目录默认 ~/.local/share/wenming-agent（与 standalone.js 一致，STATE_DIR 可覆盖）。
 */
'use strict';
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'share', 'wenming-agent');
if (!process.env.STATE_DIR) process.env.STATE_DIR = DEFAULT_STATE_DIR;

const { STATE_DIR } = require('../lib/config');
const { hashPassword } = require('../lib/auth');
const { initStateDir, loadPermissions, savePermissions, loadSessions, saveSessions } = require('../lib/state');

const USERNAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const genPassword = () => crypto.randomBytes(9).toString('base64url');

/** 改密/删号要失效该账号的登录会话（与站点 /api/permissions 的行为一致：OWASP Session Management） */
async function killSessions(username) {
  const sessions = await loadSessions();
  let n = 0;
  for (const k of Object.keys(sessions)) {
    if (sessions[k] && sessions[k].username === username) { delete sessions[k]; n++; }
  }
  if (n) await saveSessions(sessions);
  return n;
}

function usage() {
  console.log(`用法：
  node tools/users.js list
  node tools/users.js add <名字> [密码] [--admin]    （省略密码 = 随机生成并打印）
  node tools/users.js passwd <名字> [密码]

数据目录：${STATE_DIR}`);
}

(async () => {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') return usage();

  initStateDir();
  const perms = await loadPermissions();
  if (!Array.isArray(perms.users)) perms.users = [];
  if (!perms.sessionHours) perms.sessionHours = 168;

  if (cmd === 'list') {
    if (!perms.users.length) return console.log('（还没有账号：node tools/users.js add admin --admin）');
    console.log(`共 ${perms.users.length} 个账号（数据目录 ${STATE_DIR}）：`);
    for (const u of perms.users) console.log(`  ${u.username}${u.admin ? '  [管理员]' : ''}`);
    return;
  }

  if (cmd === 'add') {
    const username = String(name || '');
    if (!USERNAME_RE.test(username)) return console.error('❌ 用户名只能是 1-32 位字母/数字/下划线/连字符');
    if (perms.users.some((u) => u.username === username)) return console.error('❌ 已存在同名账号：' + username);
    const admin = rest.includes('--admin');
    const password = rest.find((a) => !a.startsWith('--')) || genPassword();
    const salt = crypto.randomBytes(16).toString('hex');
    perms.users.push({
      username, displayName: username, salt, passwordHash: hashPassword(password, salt),
      scopes: [], editScopes: [], uploadQuotaBytes: 0, admin,
    });
    await savePermissions(perms);
    console.log(`✅ 已创建 ${username}${admin ? '（管理员）' : ''}`);
    console.log(`   密码：${password}${rest.some((a) => !a.startsWith('--')) ? '' : '（随机生成，只显示这一次）'}`);
    return;
  }

  if (cmd === 'passwd') {
    const username = String(name || '');
    const user = perms.users.find((u) => u.username === username);
    if (!user) return console.error('❌ 没有这个账号：' + username);
    const password = rest.find((a) => !a.startsWith('--')) || genPassword();
    user.salt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = hashPassword(password, user.salt);
    await savePermissions(perms);
    const killed = await killSessions(username);
    console.log(`✅ 已更新 ${username} 的密码${killed ? `；已失效该账号的 ${killed} 个登录会话` : ''}`);
    console.log(`   新密码：${password}${rest.some((a) => !a.startsWith('--')) ? '' : '（随机生成，只显示这一次）'}`);
    return;
  }

  usage();
})();
