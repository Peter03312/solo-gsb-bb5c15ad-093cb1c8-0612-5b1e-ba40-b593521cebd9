'use strict';
// 草案引用影响链 端到端冒烟测试。
// 用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/impact.e2e.js
const base = process.env.E2E_BASE || 'http://127.0.0.1:3999';

let pass = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  pass++;
  console.log('  ✓ ' + msg);
}

async function call(method, p, body, expected) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (expected && res.status !== expected) {
    console.error(`✗ ${method} ${p} expected ${expected}, got ${res.status}:`, JSON.stringify(data));
    process.exit(1);
  }
  return { status: res.status, data };
}

async function main() {
  // 首版 v1：A B C X Y Z
  //   X->A, Y->X, Z->Y（一条长度 3 的反向链 Z→Y→X→A）
  //   C->B, A->C
  await call('POST', '/api/initialize', {
    charter_title: '引用影响测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '职责', body: 'CCC' },
      { key: 'X', title: '经费', body: 'XXX' },
      { key: 'Y', title: '监督', body: 'YYY' },
      { key: 'Z', title: '评议', body: 'ZZZ' },
    ],
    refs: [
      { source: 'X', target: 'A', label: '依据' },
      { source: 'Y', target: 'X', label: '' },
      { source: 'Z', target: 'Y', label: '' },
      { source: 'C', target: 'B', label: '' },
      { source: 'A', target: 'C', label: '' },
    ],
  }, 201);

  // ----------------------------------------------------------------------
  // 1) 基线即最新版：改写 A -> 变化源 A，X 直接、Y/Z 间接受影响；最短链
  // ----------------------------------------------------------------------
  const d1 = await call('POST', '/api/drafts', { name: '改总则草案' }, 201);
  const rev1 = d1.data.revision;
  await call('PUT', `/api/drafts/${d1.data.id}/clauses/A`, { title: '总则', body: 'AAA-修订' }, 200);
  let det = await call('GET', `/api/drafts/${d1.data.id}`);
  const revAfterEdit = det.data.revision;
  ok(revAfterEdit > rev1, '草案编辑后修订号递增');

  let r = await call('GET', `/api/drafts/${d1.data.id}/impact`, null, 200);
  let imp = r.data;
  ok(imp.blocked === false && imp.replayed === false, '基线即最新版：影响链可查、无需重放');
  ok(imp.draft_revision === revAfterEdit, '响应携带当前草案修订号');
  ok(imp.latest_version_id === 1, '响应携带最新版本号 v1');
  ok(imp.source_count === 1 && imp.sources[0].key === 'A' && imp.sources[0].changes.body === true, '变化源为 A（正文变化）');
  ok(!imp.sources.some((s) => s.key === 'B' || s.key === 'C'), '未改动条款不是变化源');

  const aff = Object.fromEntries(imp.affected.map((a) => [a.key, a]));
  ok(['X', 'Y', 'Z'].every((k) => aff[k]), 'X/Y/Z 均为仍存在的受影响条款');
  ok(!('B' in aff) && !('C' in aff), 'B/C 不反向引用 A，不受影响');
  ok(aff.X.direct === true, 'X 直接引用变化源 A');
  const xRel = aff.X.relations.find((x) => x.distance === 1 && x.side === 'after');
  ok(xRel.path.map((n) => n.key).join() === 'X,A' && xRel.edges[0].label === '依据', 'X->A 最短链与引用标签正确');
  ok(aff.Y.relations.some((x) => x.distance === 2 && x.path.map((n) => n.key).join() === 'Y,X,A'), 'Y 间接链 Y→X→A');
  ok(aff.Z.relations.some((x) => x.distance === 3 && x.path.map((n) => n.key).join() === 'Z,Y,X,A'), 'Z 最短链 Z→Y→X→A');
  ok(imp.candidate.clauses.find((c) => c.key === 'A').body === 'AAA-修订', '影响链返回候选版本（草案内容）');

  // 变化前后两侧都可达：纯改写不删引用
  ok(aff.X.sides.sort().join() === 'after,before', 'X 在变化前后两版均可追溯');

  // ----------------------------------------------------------------------
  // 2) 循环引用：新增 A->Y 形成环 A→C… 与 Y→X→A，环不重复、接口正常
  //    另加 D->D 自身环
  // ----------------------------------------------------------------------
  await call('POST', `/api/drafts/${d1.data.id}/refs`, { source: 'A', target: 'Y', label: '报备' }, 200);
  await call('POST', `/api/drafts/${d1.data.id}/clauses`, { key: 'D', title: '自律', body: 'DDD' }, 200);
  await call('POST', `/api/drafts/${d1.data.id}/refs`, { source: 'D', target: 'D', label: '自指' }, 200);
  r = await call('GET', `/api/drafts/${d1.data.id}/impact`);
  imp = r.data;
  ok(imp.blocked === false, '存在循环引用时影响链正常返回（不无限展开）');
  // D 为新增条款：自身不是变化源；自指环不会让它错误地成为 A 的受影响节点
  const dNode = imp.affected.find((a) => a.key === 'D');
  ok(!dNode || !dNode.relations.some((x) => x.source_key === 'A'), '自指环 D->D 不产生到其他源的路径');
  // 新增出站引用 A->Y 使 A 的出站引用变化，但入边追溯结果仍正确
  const yNode = imp.affected.find((a) => a.key === 'Y');
  ok(yNode.relations.filter((x) => x.path.map((n) => n.key).join() === 'Y,X,A').length === 2,
    'Y 到 A 只有变化前/变化后各一条最短链（环不重复）');

  // ----------------------------------------------------------------------
  // 3) 草案再次编辑后重新查询 -> 修订号变化、结论更新（只读、实时）
  // ----------------------------------------------------------------------
  det = await call('GET', `/api/drafts/${d1.data.id}`);
  const revLater = det.data.revision;
  r = await call('GET', `/api/drafts/${d1.data.id}/impact`);
  ok(r.data.draft_revision === revLater, '重新查询反映新草案修订号');

  // ----------------------------------------------------------------------
  // 4) 删除变化源：草案 d2 删除 B；C->B 的入边随删除条款被一并丢弃
  //    （删除条款时该来源条款仍在，草案通过删除引用消除悬空）
  // ----------------------------------------------------------------------
  const d2 = await call('POST', '/api/drafts', { name: '删会员草案' }, 201);
  // C 引用 B：先删引用 C->B，再删 B，保证可重放
  // 找到 C->B 的 ordinal（初始 refs 顺序：X->A,Y->X,Z->Y,C->B,A->C -> C->B 为 3）
  await call('DELETE', `/api/drafts/${d2.data.id}/refs/3`, null, 200);
  await call('DELETE', `/api/drafts/${d2.data.id}/clauses/B`, null, 200);
  r = await call('GET', `/api/drafts/${d2.data.id}/impact`);
  imp = r.data;
  ok(imp.blocked === false, '删除条款且清理入边后影响链可查');
  const srcB = imp.sources.find((s) => s.key === 'B');
  ok(srcB && srcB.kind === 'deleted', 'B 作为删除变化源');
  // C 删除了出站引用 C->B：C 自身也是变化源
  const srcC = imp.sources.find((s) => s.key === 'C');
  ok(srcC && srcC.changes.outgoing_refs, 'C 出站引用 C->B 被删，C 也是变化源');
  ok(imp.candidate.clauses.every((c) => c.key !== 'B'), '候选版本不含已删除的 B');

  // ----------------------------------------------------------------------
  // 5) 悬空草案 -> 阻断：说明原因，不返回影响结论
  // ----------------------------------------------------------------------
  const d3 = await call('POST', '/api/drafts', { name: '悬空草案' }, 201);
  await call('POST', `/api/drafts/${d3.data.id}/refs`, { source: 'A', target: 'GHOST', label: '' }, 200);
  r = await call('GET', `/api/drafts/${d3.data.id}/impact`, null, 409);
  ok(r.data.blocked === true && r.data.reason === 'DRAFT_INVALID', '悬空草案 -> 409 blocked / DRAFT_INVALID');
  ok(r.data.issues.some((i) => i.code === 'dangling-ref'), '阻断响应列出悬空引用问题');
  ok(r.data.sources === undefined && r.data.affected === undefined, '阻断时不返回影响结论');
  ok(r.data.draft_revision > 0 && r.data.latest_version_id === 1, '阻断响应仍带草案修订号与最新版本号');

  // ----------------------------------------------------------------------
  // 6) 其他草案发布后重新查询：最新版本号变化，落后草案触发重放
  //    先发布 d1（含 A 改写、A->Y、D 自指环）为 v2
  // ----------------------------------------------------------------------
  const pub1 = await call('POST', `/api/drafts/${d1.data.id}/publish`, { note: '改总则发布' }, 201);
  ok(pub1.data.version_id === 2, 'd1 发布为 v2');

  // 基线落后的不相交草案：d4 基于 v1，只改 Z 正文 -> 重放到 v2 成功
  const d4 = await call('POST', '/api/drafts', { name: '落后草案-不相交', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d4.data.id}/clauses/Z`, { title: '评议', body: 'ZZZ-落后修订' }, 200);
  r = await call('GET', `/api/drafts/${d4.data.id}/impact`, null, 200);
  imp = r.data;
  ok(imp.blocked === false && imp.replayed === true, '基线落后但不相交：影响链按重放候选版本计算');
  ok(imp.latest_version_id === 2, '响应最新版本号变为 v2（反映其他草案已发布）');
  ok(imp.sources.some((s) => s.key === 'Z'), '变化源含本草案的 Z 修订');
  // 重放候选版本同时含 v2 的 D 与 A->Y 引用
  ok(imp.candidate.clauses.some((c) => c.key === 'D'), '重放候选版本包含最新版 v2 的新增 D');
  ok(imp.candidate.refs.some((e) => e.source === 'A' && e.target === 'Y'), '重放候选版本包含 v2 的引用 A->Y');

  // ----------------------------------------------------------------------
  // 7) 基线落后且重放冲突 -> 阻断 REPLAY_CONFLICT，说明原因
  //    d5 基于 v1 改 A（v2 已改 A）-> modify-modify
  // ----------------------------------------------------------------------
  const d5 = await call('POST', '/api/drafts', { name: '落后草案-冲突', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d5.data.id}/clauses/A`, { title: '总则', body: 'AAA-冲突方' }, 200);
  r = await call('GET', `/api/drafts/${d5.data.id}/impact`, null, 409);
  ok(r.data.blocked === true && r.data.reason === 'REPLAY_CONFLICT', '重放冲突 -> 409 REPLAY_CONFLICT');
  ok(r.data.conflicts.some((c) => c.kind === 'modify-modify' && c.key === 'A'), '冲突响应逐条说明');
  ok(r.data.sources === undefined, '冲突时不返回影响结论');
  // 草案原样保留，可继续编辑
  det = await call('GET', `/api/drafts/${d5.data.id}`);
  ok(det.data.status === 'open', '只读查询不改变草案状态（仍 open）');

  // ----------------------------------------------------------------------
  // 8) 基线落后且重放后悬空 -> 阻断 REPLAY_DANGLING
  //    v2 已含 A->Y。d6 基于 v1 删除 Y（其反向链），且 d6 自身不悬空：
  //    d6 内删除 Y 时需清掉本草案里指向 Y 的引用（Z->Y、A->C 保留），
  //    但重放到 v2 后 v2 的 A->Y 跟随 A（最新版归属）保留 -> 目标 Y 缺失 -> 悬空
  // ----------------------------------------------------------------------
  const d6 = await call('POST', '/api/drafts', { name: '落后草案-悬空', baseline_id: 1 }, 201);
  // 删除条款 Y 时其出站边 Y->X 会保留为悬空：需连同 Z->Y 一起删掉，草案自身才有效。
  // 初始引用序号：0 X->A, 1 Y->X, 2 Z->Y, 3 C->B, 4 A->C
  await call('DELETE', `/api/drafts/${d6.data.id}/refs/2`, null, 200);
  await call('DELETE', `/api/drafts/${d6.data.id}/refs/1`, null, 200);
  await call('DELETE', `/api/drafts/${d6.data.id}/clauses/Y`, null, 200);
  r = await call('GET', `/api/drafts/${d6.data.id}/impact`, null, 409);
  ok(r.data.blocked === true, '重放产生问题 -> 阻断');
  ok(r.data.reason === 'REPLAY_DANGLING' || r.data.reason === 'REPLAY_CONFLICT',
    `阻断原因为重放悬空/冲突（实际：${r.data.reason}）`);
  ok((r.data.dangling || []).length || (r.data.conflicts || []).length, '响应列出悬空引用或冲突明细');
  ok(r.data.sources === undefined, '悬空阻断时不返回影响结论');

  // ----------------------------------------------------------------------
  // 9) 查询完全只读：上述失败查询后版本号仍为 2、草案可继续编辑后重查
  // ----------------------------------------------------------------------
  const ov = await call('GET', '/api/overview');
  ok(ov.data.latest_version_id === 2, '所有影响链查询均不写版本（最新仍为 v2）');

  await call('PUT', `/api/drafts/${d5.data.id}/clauses/Z`, { title: '评议', body: 'ZZZ-冲突草案改Z' }, 200);
  det = await call('GET', `/api/drafts/${d5.data.id}`);
  const d5Rev = det.data.revision;
  r = await call('GET', `/api/drafts/${d5.data.id}/impact`);
  ok(r.data.draft_revision === d5Rev, '草案继续编辑后重新查询返回最新修订号（草案未被只读查询破坏）');

  // ----------------------------------------------------------------------
  // 10) 已发布草案也可查看其（当时的）引用影响链；不存在草案 404
  // ----------------------------------------------------------------------
  r = await call('GET', `/api/drafts/${d1.data.id}/impact`);
  ok(r.data.draft_status === 'published' && r.data.blocked === false, '已发布草案仍可查看引用影响链');
  await call('GET', '/api/drafts/9999/impact', null, 404);

  console.log(`\n${pass} 项引用影响链端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
