<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import { api } from '../api';

const props = defineProps<{ worldId: string; worlds: any[] }>();
const emit = defineEmits<{ refresh: [] }>();
const tab = ref<'chapters' | 'timeline' | 'graph' | 'entities' | 'foreshadow' | 'review' | 'guidance' | 'events' | 'usage' | 'evolve'>('timeline');

const works = ref<any[]>([]);
const activeWork = ref('');
const chapters = ref<any[]>([]);
const activeChapter = ref<any>(null);
const chapterBody = ref('');
const saving = ref(false);

const state = ref<any>(null);
const tl = ref<any[]>([]);
const sliderT = ref(0);
const tMin = ref(0), tMax = ref(100);
const diffFrom = ref(0), diffTo = ref(0);
const diffResult = ref<any>(null);

const proposals = ref<any[]>([]);
const guidance = ref<any[]>([]);
const events = ref<any[]>([]);
const usage = ref<any[]>([]);
const branchTitle = ref('世界线 B');

// 编辑器
async function loadWorks() {
  if (!props.worldId) return;
  works.value = await api(`/api/works?worldId=${props.worldId}`);
  if (!works.value.length) { activeWork.value = ''; chapters.value = []; return; }
  if (!works.value.find(w => w.id === activeWork.value)) activeWork.value = works.value[0].id;
  await loadChapters();
}
async function loadChapters() {
  if (!activeWork.value) { chapters.value = []; return; }
  chapters.value = await api(`/api/works/${activeWork.value}/chapters`);
}
async function openChapter(c: any) {
  activeChapter.value = c;
  const full = await api(`/api/chapters/${c.id}`);
  chapterBody.value = full.body ?? '';
}
async function saveChapter(finalize = false) {
  if (!activeChapter.value) return;
  saving.value = true;
  try {
    if (finalize) {
      const { postSse } = await import('../api');
      await postSse(`/api/works/${activeWork.value}/finalize`, {
        chapterId: activeChapter.value.id, title: activeChapter.value.title,
        index: activeChapter.value.index, worldTime: activeChapter.value.worldTime, body: chapterBody.value,
      }, e => { if (e.event === 'proposal') loadReview(); });
      await loadAll();
    } else {
      await api(`/api/chapters/${activeChapter.value.id}`, { method: 'PUT', body: JSON.stringify({ body: chapterBody.value }) });
    }
    await loadChapters();
  } finally { saving.value = false; }
}
async function addChapter() {
  if (!activeWork.value) return;
  const r = await api(`/api/works/${activeWork.value}/chapters`, { method: 'POST', body: JSON.stringify({ title: `第${chapters.value.length + 1}章`, worldTime: (chapters.value.at(-1)?.worldTime ?? 1000) + 1 }) });
  await loadChapters();
  const c = chapters.value.find(x => x.id === (r as any).id);
  if (c) openChapter(c);
}
async function delChapter(c: any) {
  if (!confirm(`删除《${c.title}》？`)) return;
  await api(`/api/chapters/${c.id}`, { method: 'DELETE' });
  if (activeChapter.value?.id === c.id) activeChapter.value = null;
  await loadChapters();
}
async function newWork() {
  const title = prompt('作品名') ?? '';
  if (!title) return;
  await api('/api/works', { method: 'POST', body: JSON.stringify({ worldId: props.worldId, title }) });
  await loadWorks();
}

// 时间轴 / 状态
async function loadState() {
  if (!props.worldId) return;
  tl.value = await api(`/api/worlds/${props.worldId}/timeline`);
  const times = tl.value.map(e => e.worldTime);
  if (times.length) {
    tMin.value = Math.floor(Math.min(...times));
    tMax.value = Math.ceil(Math.max(...times)) + 1;
    if (!sliderT.value || sliderT.value < tMin.value) sliderT.value = tMax.value;
  }
  state.value = await api(`/api/worlds/${props.worldId}/state?at=${sliderT.value}`);
}
async function runDiff() {
  diffResult.value = await api(`/api/worlds/${props.worldId}/diff?from=${diffFrom.value}&to=${diffTo.value}`);
}
async function branchWorld() {
  await api(`/api/worlds/${props.worldId}/branch`, { method: 'POST', body: JSON.stringify({ title: branchTitle.value }) });
  emit('refresh');
  alert('已创建世界线分支（见左侧世界列表）');
}

// 审核
async function loadReview() {
  if (!props.worldId) return;
  proposals.value = await api(`/api/worlds/${props.worldId}/proposals`);
}
async function approve(p: any) {
  await api(`/api/proposals/${p.id}/approve`, { method: 'POST' });
  await Promise.all([loadReview(), loadState(), loadEvents()]);
}
async function reject(p: any) {
  await api(`/api/proposals/${p.id}/reject`, { method: 'POST' });
  await loadReview();
}
async function batchReview(action: 'approve' | 'reject') {
  const label = action === 'approve' ? '批准并落库' : '拒绝';
  if (!confirm(`确定${label}全部待审提案？`)) return;
  const r = await api(`/api/worlds/${props.worldId}/proposals/batch`, { method: 'POST', body: JSON.stringify({ action }) });
  alert(`${action === 'approve' ? '已批准' : '已拒绝'} ${(r as any).proposals} 条提案${action === 'approve' ? `（落库 ${(r as any).eventsApplied} 条事件）` : ''}`);
  await Promise.all([loadReview(), loadState()]);
}

// guidance
async function loadGuidance() {
  guidance.value = props.worldId ? await api(`/api/worlds/${props.worldId}/guidance`) : [];
}
const gTitle = ref(''), gDesc = ref('');
async function addGuidance() {
  if (!gTitle.value) return;
  await api(`/api/worlds/${props.worldId}/guidance`, { method: 'POST', body: JSON.stringify({ title: gTitle.value, description: gDesc.value }) });
  gTitle.value = ''; gDesc.value = '';
  await loadGuidance();
}
async function toggleG(g: any) {
  await api(`/api/guidance/${g.id}`, { method: 'PATCH', body: JSON.stringify({ active: !g.active }) });
  await loadGuidance();
}

// events
async function loadEvents() {
  events.value = props.worldId ? await api(`/api/worlds/${props.worldId}/events`) : [];
}
async function rollback(e: any) {
  if (!confirm(`回滚事件 #${e.sequence}（${e.kind}）？`)) return;
  await api(`/api/events/${e.id}/rollback`, { method: 'POST' });
  await Promise.all([loadEvents(), loadState()]);
}
async function loadUsage() {
  usage.value = props.worldId ? await api(`/api/worlds/${props.worldId}/usage`) : [];
  await loadGate();
  importJobs.value = await api('/api/jobs');
}

// 成本门 + Jobs 续跑
const gate = ref<any>({ roles: [] });
const importJobs = ref<any[]>([]);
async function loadGate() {
  if (!props.worldId) return;
  gate.value = await api(`/api/worlds/${props.worldId}/usage/gate`);
}
async function setBaseline() {
  try {
    const r = await api(`/api/worlds/${props.worldId}/usage/baseline`, { method: 'POST' });
    alert(`基线已设定（${(r as any).roles} 个角色）`);
    await loadGate();
  } catch (e: any) { alert(e.message); }
}
async function resumeJob(j: any) {
  // 服务端已持久化导入原文：免手工重传
  const r = await api(`/api/jobs/${j.id}/resume`, { method: 'POST', body: JSON.stringify({}) });
  alert(`已从第 ${(r as any).cursor + 1} 章续跑：${(r as any).jobId}`);
  await loadUsage();
}

// 质量指标 + 红队
const metrics = ref<any>(null);
const redteam = ref<any>(null);
async function loadMetrics() {
  metrics.value = await api(`/api/worlds/${props.worldId}/metrics`);
}
async function runRedteam() {
  redteam.value = await api(`/api/worlds/${props.worldId}/redteam`);
}
// 自进化（MD 3.5：仅元层，链式可回滚）
const evolveProposal = ref<any>(null);
const evolveHistory = ref<any[]>([]);
const maxTier = ref('open');
async function loadEvolve() {
  evolveHistory.value = await api(`/api/worlds/${props.worldId}/evolve/history`);
}
async function genEvolve(apply: boolean) {
  evolveProposal.value = null;
  const { postSse } = await import('../api');
  await postSse(`/api/worlds/${props.worldId}/evolve`, { autoApply: apply }, e => {
    if (e.event === 'evolve_proposal') evolveProposal.value = e.data;
    if (e.event === 'applied') { evolveProposal.value = { ...evolveProposal.value, applied: e.data }; loadEvolve(); }
    if (e.event === 'error') alert(e.data.message);
  });
}
async function rollbackOverride(o: any) {
  const r = await api(`/api/evolve/${o.id}/rollback`, { method: 'POST' });
  if (!(r as any).ok) alert('该版本没有更早的历史可回滚');
  await loadEvolve();
}
async function setTier() {
  await api(`/api/worlds/${props.worldId}/tier`, { method: 'PATCH', body: JSON.stringify({ maxTier: maxTier.value }) });
}
async function loadAll() {
  await Promise.all([loadState(), loadReview(), loadGuidance(), loadEvents(), loadUsage(), loadEvolve()]);
}

watch(() => props.worldId, async () => { activeWork.value = ''; activeChapter.value = null; await loadWorks(); await loadAll(); });
watch(tab, t => {
  if (t === 'review') loadReview();
  if (t === 'guidance') loadGuidance();
  if (t === 'events') loadEvents();
  if (t === 'usage') loadUsage();
});
onMounted(async () => { await loadWorks(); await loadAll(); });

// 关系图布局（环形）
const graphNodes = computed(() => {
  const chars = Object.values(state.value?.characters ?? {}) as any[];
  const n = chars.length || 1;
  const R = Math.min(160, 40 + n * 14);
  return chars.map((c, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { ...c, x: 300 + R * Math.cos(a), y: 210 + R * Math.sin(a) };
  });
});
const graphEdges = computed(() => {
  const idx: Record<string, any> = {};
  graphNodes.value.forEach(n => idx[n.id] = n);
  return (state.value?.relations ?? []).map((r: any) => ({ ...r, a: idx[r.from], b: idx[r.to] })).filter(e => e.a && e.b);
});
const nameOf = (id: string) => state.value?.characters?.[id]?.name ?? id;
const unrecovered = computed(() => (state.value?.foreshadowings ?? []).filter((f: any) => f.recoveredAt == null));
</script>

<template>
  <div v-if="worldId">
    <div class="row" style="margin-bottom:12px">
      <select v-model="activeWork" @change="loadChapters">
        <option value="" disabled>选择作品…</option>
        <option v-for="w in works" :key="w.id" :value="w.id">《{{ w.title }}》</option>
      </select>
      <button class="small" @click="newWork">+ 新作品</button>
      <span class="tag">{{ worlds.find(w => w.id === worldId)?.title }}</span>
      <span class="tag ok">事件流 #{{ state?.asOf?.sequence ?? 0 }}</span>
      <span class="tag">t = {{ sliderT }}</span>
    </div>

    <div class="tabs">
      <div v-for="t in (['timeline','graph','chapters','entities','foreshadow','review','guidance','events','usage','evolve'] as const)" :key="t"
        class="tab" :class="{ active: tab === t }" @click="tab = t">
        {{ { timeline: '🕒 时间轴', graph: '🕸 关系图', chapters: '📝 章节编辑', entities: '👤 人物/设定', foreshadow: '🪤 伏笔', review: '🔍 审核队列', guidance: '🧭 Guidance', events: '📜 事件流', usage: '💰 用量', evolve: '🧬 自进化' }[t] }}
        <span v-if="t === 'review' && proposals.filter(p => p.status === 'pending').length" class="tag warn">{{ proposals.filter(p => p.status === 'pending').length }}</span>
      </div>
    </div>

    <!-- 时间轴 -->
    <div v-if="tab === 'timeline'">
      <div class="card">
        <h3>🕒 世界时间轴（拖动滑块 = 重放到该时刻，killer 四视图之一）</h3>
        <input class="timeline-slider" type="range" :min="tMin" :max="tMax" step="0.1" v-model.number="sliderT" @input="loadState">
        <div class="row"><span class="dimmer">{{ tMin }}</span><b style="flex:1;text-align:center;font-size:16px">t = {{ sliderT }}</b><span class="dimmer">{{ tMax }}</span></div>
      </div>
      <div class="grid2">
        <div class="card">
          <h3>该时刻的人物状态</h3>
          <table>
            <tr><th>人物</th><th>位置</th><th>状态</th></tr>
            <tr v-for="(c, id) in state?.characters ?? {}" :key="id">
              <td>{{ c.name }} <span v-if="c.isDead" class="tag bad">已死</span></td>
              <td>{{ state?.locations?.[id] ?? '—' }}</td>
              <td class="dimmer">{{ Object.entries(c.attrs ?? {}).map(([k, v]) => `${k}:${v}`).join(' / ') || '—' }}</td>
            </tr>
          </table>
          <div v-if="!Object.keys(state?.characters ?? {}).length" class="empty">此时刻尚无人物</div>
        </div>
        <div class="card">
          <h3>该时刻有效的关系/设定</h3>
          <div v-for="r in state?.relations ?? []" :key="r.id" class="row" style="margin-bottom:4px">
            <span class="tag">{{ nameOf(r.from) }} —{{ r.type }}→ {{ nameOf(r.to) }}</span>
            <span class="dimmer">{{ r.validFrom }} ~ {{ r.validTo ?? '今' }}</span>
          </div>
          <div v-for="f in state?.facts ?? []" :key="f.key + f.validFrom" class="dimmer" style="margin-bottom:4px">
            · {{ f.key }} = {{ f.value }}
          </div>
        </div>
      </div>
      <div class="card">
        <h3>🔀 Diff 视图（任意两时刻的世界差异）</h3>
        <div class="row">
          <input v-model.number="diffFrom" type="number" style="min-width:90px"> t →
          <input v-model.number="diffTo" type="number" style="min-width:90px"> t
          <button class="primary" @click="runDiff">对比</button>
          <button @click="branchWorld">🌱 从当前创建世界线分支</button>
          <input v-model="branchTitle" style="min-width:110px">
        </div>
        <div v-if="diffResult" style="margin-top:10px">
          <div v-if="!diffResult.characters.length && !diffResult.relations.length && !diffResult.facts.length && !diffResult.locations.length" class="empty">两时刻无差异</div>
          <div v-for="c in diffResult.characters" :key="c.id" class="row">👤 {{ c.id }}：{{ c.change }}（{{ c.before?.name ?? '—' }} → {{ c.after?.name ?? '—' }}）</div>
          <div v-for="r in diffResult.relations" :key="r.id" class="row">🔗 {{ r.id.slice(0, 30) }}：{{ r.change }}</div>
          <div v-for="f in diffResult.facts" :key="f.key" class="row">📘 {{ f.key }}：{{ f.change }}（{{ f.before ?? '—' }} → {{ f.after ?? '—' }}）</div>
          <div v-for="l in diffResult.locations" :key="l.charId" class="row">📍 {{ nameOf(l.charId) }}：{{ l.before ?? '—' }} → {{ l.after ?? '—' }}</div>
        </div>
      </div>
    </div>

    <!-- 关系图 -->
    <div v-else-if="tab === 'graph'">
      <div class="card">
        <h3>🕸 人物关系图（t = {{ sliderT }} 时刻有效的关系）</h3>
        <svg class="graph-svg" viewBox="0 0 600 420">
          <g v-for="e in graphEdges" :key="e.id">
            <line class="graph-edge" :x1="e.a.x" :y1="e.a.y" :x2="e.b.x" :y2="e.b.y" />
            <text class="graph-edge-label" :x="(e.a.x + e.b.x) / 2" :y="(e.a.y + e.b.y) / 2 - 4">{{ e.type }}</text>
          </g>
          <g v-for="n in graphNodes" :key="n.id" class="graph-node">
            <circle :cx="n.x" :cy="n.y" :r="n.isDead ? 14 : 18" :fill="n.isDead ? '#4a1d1d' : '#1e3a5f'" stroke="#3b82f6" stroke-width="1.5" />
            <text :x="n.x" :y="n.y + 32">{{ n.name }}</text>
            <text v-if="state?.locations?.[n.id]" :x="n.x" :y="n.y + 46" style="font-size:10px" fill="#8b96a5">@{{ state.locations[n.id] }}</text>
          </g>
          <text v-if="!graphNodes.length" x="300" y="210" text-anchor="middle" fill="#8b96a5">暂无人物事件</text>
        </svg>
      </div>
    </div>

    <!-- 章节编辑 -->
    <div v-else-if="tab === 'chapters'">
      <div class="grid2">
        <div class="card">
          <h3>章节 <button class="small" style="margin-left:8px" @click="addChapter">+ 新章</button></h3>
          <div class="scroll-pane">
            <div v-for="c in chapters" :key="c.id" class="chapter-list-item" :class="{ active: activeChapter?.id === c.id }" @click="openChapter(c)">
              <span>{{ c.index + 1 }}. {{ c.title }}</span>
              <span class="dimmer">t={{ c.worldTime }} · {{ c.wordCount ?? 0 }}字</span>
              <button class="small danger" @click.stop="delChapter(c)">×</button>
            </div>
            <div v-if="!chapters.length" class="empty">暂无章节，点「+ 新章」或在书架页导入小说</div>
          </div>
        </div>
        <div class="card">
          <h3 v-if="activeChapter">《{{ activeChapter.title }}》</h3>
          <h3 v-else>选择左侧章节</h3>
          <textarea v-if="activeChapter" v-model="chapterBody" class="editor-area" placeholder="正文（Markdown）"></textarea>
          <div v-if="activeChapter" class="row" style="margin-top:10px">
            <button @click="saveChapter(false)" :disabled="saving">{{ saving ? '…' : '💾 保存草稿' }}</button>
            <button class="primary" @click="saveChapter(true)" :disabled="saving">✅ 定稿并同步事实（进漏斗）</button>
            <span class="dimmer">定稿 = 锚点入库 + 增量抽取提案</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 人物/设定 -->
    <div v-else-if="tab === 'entities'">
      <div class="grid2">
        <div class="card">
          <h3>👤 人物（t = {{ sliderT }}）</h3>
          <div v-for="c in state?.characters ?? {}" :key="c.id" class="card" style="margin-bottom:8px">
            <div class="row"><b>{{ c.name }}</b><span v-if="c.isDead" class="tag bad">已死 t={{ c.diedAt }}</span><span v-if="c.gender" class="tag">{{ c.gender }}</span></div>
            <div class="kv" style="margin-top:6px">
              <span class="k" v-for="(v, k) in c.attrs" :key="String(k)"></span>
            </div>
            <div class="dimmer" style="margin-top:4px">
              <span v-for="(v, k) in c.attrs" :key="String(k)" class="tag" style="margin-right:4px">{{ k }}: {{ v }}</span>
            </div>
          </div>
          <div v-if="!Object.keys(state?.characters ?? {}).length" class="empty">暂无人物</div>
        </div>
        <div class="card">
          <h3>📘 设定（区间事实）</h3>
          <table>
            <tr><th>key</th><th>value</th><th>有效期</th></tr>
            <tr v-for="f in state?.facts ?? []" :key="f.key + f.validFrom">
              <td class="mono">{{ f.key }}</td><td>{{ f.value }}</td>
              <td class="dimmer">{{ f.validFrom }} ~ {{ f.validTo ?? '今' }}</td>
            </tr>
          </table>
        </div>
      </div>
    </div>

    <!-- 伏笔 -->
    <div v-else-if="tab === 'foreshadow'">
      <div class="card">
        <h3>🪤 伏笔（未回收项注入导演压力，MD 10.2）</h3>
        <table>
          <tr><th>描述</th><th>埋设 t</th><th>期限</th><th>状态</th></tr>
          <tr v-for="f in state?.foreshadowings ?? []" :key="f.id">
            <td>{{ f.description }}</td><td>{{ f.plantedAt }}</td><td>{{ f.deadlineWorldTime ?? '—' }}</td>
            <td>
              <span v-if="f.recoveredAt != null" class="tag ok">已回收 t={{ f.recoveredAt }}</span>
              <span v-else-if="f.deadlineWorldTime != null && f.deadlineWorldTime < sliderT" class="tag bad">逾期未收</span>
              <span v-else class="tag warn">待回收</span>
            </td>
          </tr>
        </table>
        <div v-if="!uncovered?.length && !(state?.foreshadowings ?? []).length" class="empty">暂无伏笔</div>
      </div>
    </div>

    <!-- 审核队列 -->
    <div v-else-if="tab === 'review'">
      <div class="card">
        <h3>🔍 对抗审漏斗（AI 只提案，批准才落库）</h3>
        <div class="row" style="margin-bottom:10px" v-if="proposals.filter(p => p.status === 'pending').length > 1">
          <span class="dimmer">批量处理 {{ proposals.filter(p => p.status === 'pending').length }} 条待审：</span>
          <button class="primary small" @click="batchReview('approve')">✓ 全部批准</button>
          <button class="danger small" @click="batchReview('reject')">✗ 全部拒绝</button>
        </div>
        <div v-for="p in proposals" :key="p.id" class="card" style="margin-bottom:10px">
          <div class="row">
            <span class="mono dimmer">{{ p.id }}</span>
            <span class="tag">{{ p.sourceLabel }}</span>
            <span v-if="p.status === 'pending'" class="tag warn">待审</span>
            <span v-else-if="p.status === 'approved'" class="tag ok">已通过</span>
            <span v-else class="tag bad">已拒绝</span>
            <span v-if="p.adversarial" :class="['tag', p.adversarial.verdict === 'normal' ? 'ok' : p.adversarial.verdict === 'conflict' ? 'bad' : 'warn']">
              对抗审：{{ p.adversarial.verdict }}{{ p.adversarial.reason ? `（${p.adversarial.reason}）` : '' }}
            </span>
          </div>
          <div v-if="!p.autoCheck.ok" class="tag bad" style="margin-top:6px">自动校验：{{ p.autoCheck.issues.join('；') }}</div>
          <table style="margin-top:8px">
            <tr><th>事件</th><th>payload</th><th>t</th></tr>
            <tr v-for="(e, i) in p.events" :key="i">
              <td class="mono">{{ e.kind }}</td><td class="mono dimmer">{{ JSON.stringify(e.payload).slice(0, 120) }}</td><td>{{ e.worldTime }}</td>
            </tr>
          </table>
          <div class="row" style="margin-top:8px" v-if="p.status === 'pending'">
            <button class="primary small" @click="approve(p)">✓ 批准并落库</button>
            <button class="danger small" @click="reject(p)">✗ 拒绝</button>
          </div>
        </div>
        <div v-if="!proposals.length" class="empty">队列为空</div>
      </div>
    </div>

    <!-- Guidance -->
    <div v-else-if="tab === 'guidance'">
      <div class="card">
        <h3>🧭 Guidance 锚点（注入导演/渲染/自进化的用户期望）</h3>
        <div class="row">
          <input v-model="gTitle" placeholder="标题，如：文风">
          <input v-model="gDesc" placeholder="描述，如：冷峻短句" style="flex:1">
          <button class="primary" @click="addGuidance">添加</button>
        </div>
        <table style="margin-top:10px">
          <tr><th>标题</th><th>描述</th><th>状态</th><th></th></tr>
          <tr v-for="g in guidance" :key="g.id">
            <td><b>{{ g.title }}</b></td><td>{{ g.description }}</td>
            <td><span :class="['tag', g.active ? 'ok' : '']" style="cursor:pointer" @click="toggleG(g)">{{ g.active ? '生效中' : '已停用' }}</span></td>
            <td></td>
          </tr>
        </table>
      </div>
    </div>

    <!-- 事件流 -->
    <div v-else-if="tab === 'events'">
      <div class="card">
        <h3>📜 事件流（append-only，可回滚不可删除）</h3>
        <table>
          <tr><th>#</th><th>kind</th><th>摘要</th><th>t</th><th>来源</th><th>审</th><th></th></tr>
          <tr v-for="e in events" :key="e.id" :style="{ opacity: e.supersededBy ? .45 : 1 }">
            <td class="mono">{{ e.sequence }}</td>
            <td><span class="tag">{{ e.kind }}</span></td>
            <td class="mono dimmer">{{ JSON.stringify(e.payload).slice(0, 90) }}</td>
            <td>{{ e.worldTime }}</td>
            <td class="dimmer">{{ e.actor }}{{ e.sourceRef ? ` · ${e.sourceRef.slice(0, 18)}` : '' }}</td>
            <td><span v-if="e.supersededBy" class="tag bad">已回滚</span><span v-else class="tag ok">{{ e.review.status }}</span></td>
            <td><button v-if="!e.supersededBy && !e.meta" class="small danger" @click="rollback(e)">回滚</button></td>
          </tr>
        </table>
      </div>
    </div>

    <!-- 自进化（元层） -->
    <div v-else-if="tab === 'evolve'">
      <div class="card">
        <h3>🧬 元层自进化（只进化抽取纪律，禁改剧情/品味；链式可回滚）</h3>
        <div class="row">
          <button class="primary" @click="genEvolve(false)">生成提案（依据 Guidance）</button>
          <button v-if="evolveProposal && !evolveProposal.applied" @click="genEvolve(true)">应用该提案</button>
          <span class="dimmer">世界内容分级上限：
            <select v-model="maxTier" @change="setTier" style="min-width:90px">
              <option value="open">open</option><option value="standard">standard</option><option value="safe">safe</option>
            </select>
          </span>
        </div>
        <div v-if="evolveProposal" class="card" style="margin-top:10px">
          <div class="dimmer">理由：{{ evolveProposal.reason }} · 服务：{{ evolveProposal.serves || '未注明' }}</div>
          <div class="beat-box" style="margin-top:6px">{{ evolveProposal.patch }}</div>
          <div v-if="evolveProposal.applied" class="tag ok">已应用（追加为抽取器覆盖）</div>
        </div>
      </div>
      <div class="card">
        <h3>覆盖历史（回滚 = 恢复上一版为新头部）</h3>
        <table>
          <tr><th>时间</th><th>角色</th><th>内容</th><th></th></tr>
          <tr v-for="o in evolveHistory" :key="o.id">
            <td class="dimmer">{{ o.created_at?.slice(0, 19).replace('T', ' ') }}</td>
            <td><span class="tag">{{ o.role }}</span></td>
            <td class="mono dimmer">{{ o.text.slice(0, 80) }}</td>
            <td><button class="small danger" @click="rollbackOverride(o)">回滚</button></td>
          </tr>
        </table>
        <div v-if="!evolveHistory.length" class="empty">暂无元层变更</div>
      </div>
    </div>

    <!-- 用量 -->
    <div v-else-if="tab === 'usage'">
      <div class="card">
        <h3>💰 用量与成本（按角色计费，MD 6 成本透明）</h3>
        <table>
          <tr><th>角色</th><th>模型</th><th>调用</th><th>输入 tok</th><th>输出 tok</th></tr>
          <tr v-for="u in usage" :key="u.role + u.model">
            <td><span class="tag">{{ u.role }}</span></td><td class="mono">{{ u.model }}</td>
            <td>{{ u.calls }}</td><td>{{ u.it }}</td><td>{{ u.ot }}</td>
          </tr>
        </table>
        <div v-if="!usage.length" class="empty">暂无调用记录（跑一次会话后可见）</div>
      </div>
      <div class="card">
        <h3>🚧 成本涨幅审批门（基线 vs 当前，>20% 需重设基线确认）</h3>
        <div class="row" style="margin-bottom:8px">
          <button @click="loadGate">刷新</button>
          <button class="primary" @click="setBaseline">以当前用量设定基线</button>
          <span class="dimmer">改模型/改 prompt 后跑几轮，再对比基线——涨幅超 20% 的角色会标红</span>
        </div>
        <table>
          <tr><th>角色</th><th>当前均值(in/out)</th><th>基线均值</th><th>涨跌</th><th>状态</th></tr>
          <tr v-for="g in gate.roles" :key="g.role">
            <td><span class="tag">{{ g.role }}</span></td>
            <td>{{ g.avgIn }} / {{ g.avgOut }}（{{ g.calls }} 次）</td>
            <td>{{ g.baseline ? `${g.baseline.avgIn} / ${g.baseline.avgOut}` : '—' }}</td>
            <td>{{ g.deltaPct != null ? (g.deltaPct > 0 ? '+' : '') + g.deltaPct + '%' : '—' }}</td>
            <td>
              <span v-if="g.status === 'breached'" class="tag bad">⚠ 超 20%，需确认</span>
              <span v-else-if="g.status === 'ok'" class="tag ok">正常</span>
              <span v-else class="tag">无基线</span>
            </td>
          </tr>
        </table>
        <div v-if="!gate.roles?.length" class="empty">暂无数据</div>
      </div>
      <div class="card">
        <h3>📊 回合质量指标（千回合 idle 率 / 文风分布）+ 红队泄漏扫描</h3>
        <div class="row" style="margin-bottom:8px">
          <button @click="loadMetrics">刷新指标</button>
          <button @click="runRedteam">🛡 红队扫描</button>
          <span class="dimmer">idle 率验收线 &lt;150‰（MD §9.4）；红队泄漏率应为 0‰</span>
        </div>
        <div v-if="metrics" class="row">
          <span class="tag">会话 {{ metrics.sessions }}</span>
          <span class="tag">回合 {{ metrics.turns }}</span>
          <span class="tag" :class="metrics.idlePerMill < 150 ? 'ok' : 'warn'">idle {{ metrics.idlePerMill }}‰（{{ metrics.idleTurns }} 回合）</span>
          <span class="tag ok">文风 good {{ metrics.prose.good }}</span>
          <span class="tag warn">ok {{ metrics.prose.ok }}</span>
          <span class="tag bad">flat {{ metrics.prose.flat }}</span>
        </div>
        <div v-if="redteam" class="row" style="margin-top:8px">
          <span class="tag" :class="redteam.leakRatePerMill === 0 ? 'ok' : 'bad'">
            泄漏率 {{ redteam.leakRatePerMill }}‰（{{ redteam.leaks }}/{{ redteam.attempts }} 次试探）
          </span>
          <span v-for="d in redteam.details.slice(0, 5)" :key="d" class="tag bad">{{ d }}</span>
        </div>
      </div>
      <div class="card">
        <h3>🧾 导入任务（断点续跑）</h3>
        <div v-for="j in importJobs.filter(x => x.status === 'error' || x.status === 'cancelled').slice(0, 5)" :key="j.id" class="row" style="margin-bottom:6px">
          <span class="dimmer mono">{{ j.id }}</span><span>{{ j.label }}</span>
          <span class="tag warn">{{ j.status }} @ {{ j.cursor ?? 0 }}/{{ j.total }}</span>
          <button class="small" @click="resumeJob(j)">▶ 续跑（重传原文）</button>
        </div>
        <div v-if="!importJobs.filter(x => x.status === 'error' || x.status === 'cancelled').length" class="empty">没有中断的导入任务</div>
      </div>
    </div>
  </div>
  <div v-else class="empty">请先在书架创建或选择世界</div>
</template>
