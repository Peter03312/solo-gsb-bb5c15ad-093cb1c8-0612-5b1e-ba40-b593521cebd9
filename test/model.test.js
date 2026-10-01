'use strict';
// 纯逻辑测试：node test/model.test.js
const assert = require('assert');
const {
  buildState,
  touchedClauses,
  replayDraft,
  validateState,
  hasBlockingIssues,
  diffStates,
  movedKeys,
  textDiff,
  referenceImpact,
} = require('../src/model');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function S(order, clauses, edges = []) {
  return buildState({
    order,
    clauses: clauses.map(([key, title, body]) => ({ key, title, body: body || title })),
    edges,
  });
}

const baseline = S(
  ['A', 'B', 'C'],
  [
    ['A', '总则'],
    ['B', '会员'],
    ['C', '附则'],
  ],
  [{ source: 'A', target: 'B', label: '见' }],
);

test('不相交改动可重放：草案改 A，最新版改 C', () => {
  const draft = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则修订', '新内容'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则修订'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.clauses.get('A').title, '总则修订');
  assert.strictEqual(r.merged.clauses.get('C').title, '附则修订');
});

test('同一条款双方改动 -> modify-modify 冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则Y'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, 'modify-modify');
  assert.strictEqual(r.conflicts[0].key, 'A');
});

test('双方同样修改（收敛）不冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok);
});

test('草案删除、最新版修改 -> delete-modify 冲突', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'delete-modify' && c.key === 'A'));
});

test('双方都删除 A -> 收敛，结果不含 A', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.ok(!r.merged.clauses.has('A'));
  assert.deepStrictEqual(r.merged.order, ['B', 'C']);
});

test('重放后引用悬空（草案删 B，但保留 A->B 引用为悬空暂存；最新版没动）-> 拒绝', () => {
  // 删除条款时入边保留在草案中（可暂存的悬空引用）
  const draft = S(
    ['A', 'C'],
    [
      ['A', '总则'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [
      { source: 'A', target: 'B', label: '见' },
      { source: 'C', target: 'A', label: '' },
    ],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.dangling.some((d) => d.source === 'A' && d.target === 'B'));
});

test('草案删除 B 且最新版也删除 B（引用一并消失）-> 不悬空', () => {
  const draft = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const latest = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.edges.length, 0);
});

test('新增条款不相交：草案加 D，最新版加 E，顺序按锚点插入', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '附则二']], baseline.edges);
  const latest = S(['A', 'E', 'B', 'C'], [['A', '总则'], ['E', '新增E'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  // E 在最新版的位置（A 后），D 由草案放置在末尾
  assert.deepStrictEqual(r.merged.order, ['A', 'E', 'B', 'C', 'D']);
});

test('双方新增同标识但内容不同 -> add-add 冲突', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '草案的D']], baseline.edges);
  const latest = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '最新版的D']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'add-add'));
});

test('草案移动 B 到末尾，最新版改 C：重放后 B 在末尾', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员'], ['C', '附则X']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['B']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('C').title, '附则X');
  assert.ok(r.mergedMoved.has('B'));
});

test('草案前移 C（显式移动 C），最新版只改 B 正文：不相交，可重放', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员修订'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['C']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('B').title, '会员修订');
});

test('显式移动集合用于触碰判定（被动让位条款不算移动）', () => {
  const other = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const t = touchedClauses(baseline, other, new Set(['C']));
  assert.ok(t.get('C').position); // C 被显式移动
  assert.strictEqual(t.get('B'), undefined); // B 只是被动让位
  assert.strictEqual(t.get('A'), undefined);
});

test('草案可暂存悬空引用：validate 报 error，阻止发布', () => {
  const s = S(['A'], [['A', '总则']], [{ source: 'A', target: 'ZZZ', label: '' }]);
  const issues = validateState(s);
  assert.ok(issues.some((i) => i.code === 'dangling-ref'));
  assert.ok(hasBlockingIssues(issues));
});

test('结构差异：新增/删除/修改分类', () => {
  const d = diffStates(
    baseline,
    S(['A', 'C'], [['A', '总则改'], ['C', '附则']], [{ source: 'C', target: 'A', label: '' }]),
  );
  assert.deepStrictEqual(d.deleted, ['B']);
  assert.ok(d.changed.some((c) => c.key === 'A' && c.body));
  assert.strictEqual(d.refsRemoved.length, 1);
  assert.strictEqual(d.refsAdded.length, 1);
});

test('textDiff 中文按字标注增删', () => {
  const segs = textDiff('社团章程', '社团新章程');
  const ins = segs.filter((s) => s.op === 'ins').map((s) => s.text).join('');
  const del = segs.filter((s) => s.op === 'del').map((s) => s.text).join('');
  assert.strictEqual(ins, '新');
  assert.strictEqual(del, '');
});

test('movedKeys 检测前驱锚点变化（交换中只标记后移者）', () => {
  assert.deepStrictEqual([...movedKeys(['A', 'B', 'C'], ['A', 'C', 'B'])], ['B']);
});

// ---------------------------------------------------------------------------
// 生效排程
// ---------------------------------------------------------------------------
const {
  pickEffectiveVersion,
  pendingVersions,
  scheduleNeighbors,
} = require('../src/model');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const H = 3600 * 1000;
function sch(rows) {
  // rows: [id, 相对 T0 的小时数, 状态]
  return rows.map(([id, h, status = 'scheduled']) => ({
    id,
    effective_at: new Date(T0 + h * H).toISOString(),
    schedule_status: status,
  }));
}

test('pickEffectiveVersion：取生效时刻已到且最大的版本；未到/已取消排除', () => {
  const vs = sch([
    [1, -10, 'immediate'], // v1 早已即时生效
    [2, 2, 'scheduled'],   // T0+2h 生效
    [3, 4, 'cancelled'],   // 被取消，永不生效
    [4, 6, 'scheduled'],   // 更晚
  ]);
  assert.strictEqual(pickEffectiveVersion(vs, T0 - H), 1);
  assert.strictEqual(pickEffectiveVersion(vs, T0), 1);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 2 * H), 2);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 3 * H), 2);
  // v3 被取消：跳过，仍是 v2
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 5 * H), 2);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 6 * H), 4);
  // 无任何已生效版本
  assert.strictEqual(pickEffectiveVersion(sch([[1, 1]]), T0), null);
});

test('pickEffectiveVersion：生效时刻相同时取较大 id（确定性）', () => {
  const vs = sch([
    [1, 0, 'immediate'],
    [2, 1, 'scheduled'],
  ]);
  // 构造相同时刻
  vs[1].effective_at = vs[0].effective_at;
  assert.strictEqual(pickEffectiveVersion(vs, T0 + H), 2);
});

test('pendingVersions：仅返回时刻仍在未来的 scheduled，按 id 升序', () => {
  const vs = sch([
    [1, -10, 'immediate'],
    [2, -1, 'scheduled'],  // 已到点（惰性生效），不在队列
    [3, 1, 'cancelled'],   // 取消，不在队列
    [4, 3, 'scheduled'],
    [5, 5, 'scheduled'],
  ]);
  assert.deepStrictEqual(pendingVersions(vs, T0).map((v) => v.id), [4, 5]);
});

test('scheduleNeighbors：按发布版顺序找相邻待生效版本', () => {
  const q = sch([
    [2, 1],
    [4, 3],
    [7, 5],
  ]);
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 4)).map(([k, v]) => [k, v?.id ?? null])),
    { before: 2, after: 7 },
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 2)).map(([k, v]) => [k, v?.id ?? null])),
    { before: null, after: 4 },
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 7)).map(([k, v]) => [k, v?.id ?? null])),
    { before: 4, after: null },
  );
});

// ---------------------------------------------------------------------------
// 引用影响链
// ---------------------------------------------------------------------------
test('引用影响链：正文/出站引用变化条款为变化源，反向追溯直接与最短间接链', () => {
  // L：X->A（直接），Y->X（间接），A->B 无关节联
  const latest = S(
    ['A', 'B', 'X', 'Y'],
    [['A', '总则'], ['B', '会员'], ['X', '经费'], ['Y', '监督']],
    [
      { source: 'X', target: 'A', label: '见' },
      { source: 'Y', target: 'X', label: '' },
      { source: 'A', target: 'B', label: '' },
    ],
  );
  // 候选：仅改写 A 正文
  const candidate = S(
    ['A', 'B', 'X', 'Y'],
    [['A', '总则', '总则正文-修订'], ['B', '会员'], ['X', '经费'], ['Y', '监督']],
    [
      { source: 'X', target: 'A', label: '见' },
      { source: 'Y', target: 'X', label: '' },
      { source: 'A', target: 'B', label: '' },
    ],
  );
  const imp = referenceImpact({ latest, candidate });
  assert.deepStrictEqual(imp.sources.map((s) => s.key), ['A']);
  assert.deepStrictEqual(imp.sources[0].changes, { title: false, body: true, outgoing_refs: false });
  const byKey = Object.fromEntries(imp.affected.map((a) => [a.key, a]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ['X', 'Y']);
  assert.strictEqual(byKey.X.direct, true);
  assert.deepStrictEqual(byKey.X.relations[0].path.map((n) => n.key), ['X', 'A']);
  assert.strictEqual(byKey.X.relations[0].edges[0].label, '见');
  const yRel = byKey.Y.relations.find((r) => r.distance === 2);
  assert.ok(yRel && !yRel.direct, 'Y 为间接受影响');
  assert.deepStrictEqual(yRel.path.map((n) => n.key), ['Y', 'X', 'A']);
  // B 不反向引用 A，不受影响
  assert.strictEqual(byKey.B, undefined);
});

test('引用影响链：循环引用不重复、不无限展开', () => {
  const latest = S(
    ['A', 'B', 'C'],
    [['A', '总则'], ['B', '会员'], ['C', '附则']],
    [
      { source: 'B', target: 'A', label: '' },
      { source: 'A', target: 'B', label: '' }, // A<->B 环
      { source: 'C', target: 'B', label: '' },
    ],
  );
  const candidate = S(
    ['A', 'B', 'C'],
    [['A', '总则改'], ['B', '会员'], ['C', '附则']],
    [
      { source: 'B', target: 'A', label: '' },
      { source: 'A', target: 'B', label: '' },
      { source: 'C', target: 'B', label: '' },
    ],
  );
  const imp = referenceImpact({ latest, candidate });
  // B 到 A 为直接链（B->A），不应因为环 A->B 而重复出现多条路径
  const b = imp.affected.find((a) => a.key === 'B');
  assert.ok(b);
  assert.strictEqual(b.relations.length, 2); // before / after 各一条
  assert.deepStrictEqual(b.relations[0].path.map((n) => n.key), ['B', 'A']);
  const c = imp.affected.find((a) => a.key === 'C');
  assert.deepStrictEqual(c.relations.find((r) => r.distance === 2).path.map((n) => n.key), ['C', 'B', 'A']);
});

test('引用影响链：删除源与出站引用变化源；变化前链不拼到变化后，链消失时标注', () => {
  // L：X->B；候选删除 B（X 不再引用 B，故 X 的出站引用也变化），并改写 A
  const latest = S(
    ['A', 'B', 'X'],
    [['A', '总则'], ['B', '会员'], ['X', '经费']],
    [{ source: 'X', target: 'B', label: '' }],
  );
  const candidate = S(
    ['A', 'X'],
    [['A', '总则改'], ['X', '经费']],
    [],
  );
  const imp = referenceImpact({ latest, candidate });
  const srcB = imp.sources.find((s) => s.key === 'B');
  assert.strictEqual(srcB.kind, 'deleted');
  const srcX = imp.sources.find((s) => s.key === 'X');
  assert.ok(srcX && srcX.changes.outgoing_refs, 'X 出站引用被删除，本身也是变化源');
  // 变化前 X 沿 X->B 可追到删除源 B，但 X 自身是变化源，不重复列为受影响条款
  assert.ok(!imp.affected.some((a) => a.key === 'X'));
});

test('引用影响链：新增条款不是变化源；变化前后两侧关系独立标注', () => {
  const latest = S(
    ['A', 'X'],
    [['A', '总则'], ['X', '经费']],
    [{ source: 'X', target: 'A', label: '' }],
  );
  // 改写 A；新增 D 且 D->A（D 在变化前不存在，但作为受影响条款从变化后图可达）
  const candidate = S(
    ['A', 'X', 'D'],
    [['A', '总则改'], ['X', '经费'], ['D', '新条']],
    [
      { source: 'X', target: 'A', label: '' },
      { source: 'D', target: 'A', label: '' },
    ],
  );
  const imp = referenceImpact({ latest, candidate });
  assert.deepStrictEqual(imp.sources.map((s) => s.key), ['A']);
  const keys = imp.affected.map((a) => a.key).sort();
  assert.deepStrictEqual(keys, ['D', 'X']);
  const d = imp.affected.find((a) => a.key === 'D');
  assert.deepStrictEqual(d.sides, ['after']);
  assert.ok(!d.relations.some((r) => r.side === 'before'), '新增条款 D 在变化前无图，不会拼出跨版链');
  const x = imp.affected.find((a) => a.key === 'X');
  assert.deepStrictEqual(x.sides.sort(), ['after', 'before']);
});

test('引用影响链：纯位置移动不是变化源', () => {
  const latest = S(['A', 'B'], [['A', '总则'], ['B', '会员']], []);
  const candidate = S(['B', 'A'], [['A', '总则'], ['B', '会员']], []);
  const imp = referenceImpact({ latest, candidate });
  assert.strictEqual(imp.sources.length, 0);
  assert.strictEqual(imp.affected.length, 0);
});

test('引用影响链：变化前存在的引用链在候选版被删 -> active_after=false 但仍展示', () => {
  // L：Z->Y->X->A；候选改写 A，且 X 的出站引用改为删除 X->A（X 自身也是变化源）。
  // Y、Z 自身内容与出站引用均未变；变化前 Y/Z 沿反向引用可追溯到 A，
  // 变化后链在 X 处断裂，变化前关系以 active_after=false 保留展示。
  const latest = S(
    ['A', 'X', 'Y', 'Z'],
    [['A', '总则'], ['X', '经费'], ['Y', '监督'], ['Z', '评议']],
    [
      { source: 'X', target: 'A', label: '' },
      { source: 'Y', target: 'X', label: '' },
      { source: 'Z', target: 'Y', label: '' },
    ],
  );
  const candidate = S(
    ['A', 'X', 'Y', 'Z'],
    [['A', '总则', '总则正文-修订'], ['X', '经费'], ['Y', '监督'], ['Z', '评议']],
    [
      { source: 'Y', target: 'X', label: '' },
      { source: 'Z', target: 'Y', label: '' },
    ],
  );
  const imp = referenceImpact({ latest, candidate });
  assert.ok(imp.sources.some((s) => s.key === 'X' && s.changes.outgoing_refs), '删除 X->A：X 是变化源');
  const y = imp.affected.find((a) => a.key === 'Y');
  const z = imp.affected.find((a) => a.key === 'Z');
  assert.ok(y && z, 'Y、Z 未被直接修改，作为现存受影响条款展示');
  for (const a of [y, z]) {
    // 到源 A 的变化前链已断裂（X->A 在候选版被删）
    const toABefore = a.relations.find((r) => r.source_key === 'A' && r.side === 'before');
    assert.ok(toABefore, `${a.key} 沿变化前反向引用可追溯到 A`);
    assert.strictEqual(toABefore.active_after, false);
    assert.ok(!a.relations.some((r) => r.source_key === 'A' && r.side === 'after'), `${a.key} 变化后无法再到达 A`);
  }
  assert.deepStrictEqual(
    z.relations.find((r) => r.source_key === 'A' && r.side === 'before').path.map((n) => n.key),
    ['Z', 'Y', 'X', 'A'],
  );
});

console.log(`\n${passed} 项测试全部通过`);
