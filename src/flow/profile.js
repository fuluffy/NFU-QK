/**
 * profile 加载与校验。
 *
 * profile 是整个程序里**唯一**知道"学校系统长什么样"的地方。
 * 校验做得严一点，是为了让"取证填错字段"这种事在启动时就炸掉，
 * 而不是在 12:29:59 的时候才发现少了个参数。
 */

import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'profiles');

export const REQUIRED_STEPS = ['list', 'submit'];

export async function loadProfile(nameOrPath) {
  const file =
    nameOrPath.includes('/') || nameOrPath.includes('\\') || nameOrPath.endsWith('.json')
      ? nameOrPath
      : path.join(PROFILE_DIR, `${nameOrPath}.json`);

  const text = await readFile(file, 'utf8');
  const profile = JSON.parse(text);
  profile.__file = file;
  validateProfile(profile);
  return profile;
}

/** @returns {{errors:string[], warnings:string[]}} */
export function checkProfile(profile) {
  const errors = [];
  const warnings = [];

  if (!profile || typeof profile !== 'object') {
    return { errors: ['profile 不是对象'], warnings };
  }
  if (!profile.baseUrl) warnings.push('未设置 baseUrl（若步骤里 path 均为绝对地址可忽略）');
  if (!Array.isArray(profile.steps) || !profile.steps.length) {
    errors.push('缺少 steps');
    return { errors, warnings };
  }

  const ids = new Set();
  for (const s of profile.steps) {
    if (!s.id) errors.push('存在没有 id 的步骤');
    if (ids.has(s.id)) errors.push(`步骤 id 重复：${s.id}`);
    ids.add(s.id);
    if (!s.path) errors.push(`步骤 ${s.id} 缺少 path`);
    if (!s.method) warnings.push(`步骤 ${s.id} 未指定 method，默认 POST`);
  }

  for (const need of REQUIRED_STEPS) {
    if (!ids.has(need)) errors.push(`缺少必需步骤：${need}`);
  }
  if (!ids.has('detail')) {
    warnings.push('缺少 detail 步骤 —— 若该系统提交不需要一次性凭证则可以忽略');
  }
  if (!ids.has('verify')) {
    warnings.push('缺少 verify 步骤 —— 提交超时后将无法确认结果，建议补上「已选列表」接口');
  }
  if (!ids.has('probe')) {
    warnings.push('缺少 probe 步骤（可选）');
  }

  const submit = profile.steps.find((s) => s.id === 'submit');
  if (submit) {
    if (!submit.success) errors.push('submit 步骤缺少 success 判定条件');
    if (submit.retry !== 'none') {
      warnings.push('submit 步骤未显式设置 retry:"none" —— 引擎会强制禁止重试，但建议在配置里写明');
    }
  }

  if (!profile.matchFields?.name && !profile.matchFields?.code) {
    warnings.push('matchFields 未配置课程名/课程号字段，将无法匹配目标');
  }

  if (profile._status?.startsWith('ASSUMED')) {
    warnings.push('该 profile 仍标记为 ASSUMED（推断值），真机取证前请勿实跑');
  } else if (profile._status && !profile._status.startsWith('VERIFIED')) {
    // DERIVED / 其它中间态：有依据但没对当前学期验证过，必须让使用者看见
    warnings.push(`该 profile 标记为「${profile._status}」—— 尚未对当前学期真机验证，字段可能已变`);
  }

  return { errors, warnings };
}

export function validateProfile(profile) {
  const { errors, warnings } = checkProfile(profile);
  if (errors.length) {
    throw new Error(`profile 校验失败（${profile?.__file ?? profile?.name ?? '?'}）：\n  - ${errors.join('\n  - ')}`);
  }
  return warnings;
}

export function listProfileNames() {
  // 扫目录而不是写死：新增一条路线（比如换了个端点族）不该还要回来改这里
  try {
    return readdirSync(PROFILE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return ['pe', 'ggxxk'];
  }
}
