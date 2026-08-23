<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { api, postSse } from '../api';

const props = defineProps<{ worlds: any[] }>();
const sessions = ref<any[]>([]);
const active = ref<any>(null);
const mode = ref<'rp' | 'write'>('rp');
const worldId = ref('');
const workId = ref('');
const title = ref('');
const charId = ref('');
const focusCharId = ref('');

const input = ref('');
const busy = ref(false);
const turnMeta = ref<any>(null);
const options = ref<string[]>([]);
const chatLog = ref<any[]>([]);
const works = ref<any[]>([]);
const packList = ref<any[]>([]);
const entryRole = ref('protagonist');
const playMode = ref('mainline');
const pendingOptionIndex = ref<number | null>(null);

async function loadPacks() {
  packList.value = await api('/api/packs');
}
loadPacks();

async function startPack(pk: any) {
  const s = await api(`/api/packs/${pk.id}/start`, { method: 'POST', body: JSON.stringify({ entryRole: entryRole.value, playMode: playMode.value }) });
  await loadSessions();
  openSession(s);
}

watch(worldId, async w => {
  works.value = [];
  workId.value = '';
  if (w) works.value = await api(`/api/works?worldId=${w}`);
});

// 写作模式
const outline = ref('');
const chapterTitle = ref('');
const draft = ref('');
const draftMetrics = ref<any>(null);
const selection = ref('');
const rewriteInstruction = ref('');
const editorEl = ref<HTMLTextAreaElement | null>(null);

async function loadSessions() {
  sessions.value = await api('/api/sessions');
}
onMounted(loadSessions);

async function createSession() {
  if (!worldId.value) { alert('选择世界'); return; }
  const s = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      worldId: worldId.value, mode: mode.value, title: title.value || (mode.value === 'rp' ? '新的演出' : '新的章节'),
      workId: workId.value || null,
      profile: mode.value === 'rp' ? { charId: charId.value || null, focusCharId: focusCharId.value || null } : undefined,
    }),
  });
  await loadSessions();
  openSession(s);
}
async function openSession(s: any) {
  active.value = await api(`/api/sessions/${s.id}`);
  chatLog.value = active.value.turns ?? [];
  options.value = [];
  turnMeta.value = null;
}
async function delSession(s: any) {
  if (!confirm(`删除会话「${s.title}」？`)) return;
  await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
  if (active.value?.id === s.id) active.value = null;
  await loadSessions();
}

async function send() {
  const msg = input.value.trim();
  if (!msg && pendingOptionIndex.value == null) return;
  if (!active.value || busy.value) return;
  input.value = '';
  busy.value = true;
  chatLog.value.push({ role: 'user', content: msg });
  const live: any = { role: 'assistant', content: '', meta: {} };
  chatLog.value.push(live);
  try {
    await postSse(`/api/sessions/${active.value.id}/turn`, { message: msg || '（选择选项）', optionIndex: pendingOptionIndex.value ?? undefined }, e => {
      if (e.event === 'beat') { live.meta.beats = e.data.beats; live.meta.tension = e.data.tension; }
      if (e.event === 'content') live.content = e.data;
      if (e.event === 'prose') live.meta.prose = e.data;
      if (e.event === 'idle') live.meta.idle = true;
      if (e.event === 'dice') live.meta.dice = e.data.roll;
      if (e.event === 'pack_move') live.meta.packMove = e.data;
      if (e.event === 'proposal') { live.meta.proposal = e.data; options.value = []; }
      if (e.event === 'done') { options.value = e.data.options ?? []; turnMeta.value = e.data; }
      if (e.event === 'error') live.content = `⚠️ ${e.data.message}`;
      chatLog.value = [...chatLog.value];
    });
  } catch (err: any) {
    live.content = `⚠️ ${err.message}`;
  }
  busy.value = false;
  pendingOptionIndex.value = null;
  chatLog.value = [...chatLog.value];
}

function pick(opt: string, idx: number) {
  // 剧本包会话（mainline）：选项芯片按索引推进节点（canon/advance 引擎白名单）
  if (active.value?.profile?.pack && active.value.profile.pack.playMode === 'mainline') {
    pendingOptionIndex.value = idx;
    input.value = opt.replace(/（(canon|advance|idle)）/, '').trim();
    send();
  } else {
    input.value = opt;
  }
}

// 写作
async function writeDraft() {
  if (!outline.value.trim() || !active.value || busy.value) return;
  busy.value = true;
  draft.value = '';
  try {
    await postSse(`/api/sessions/${active.value.id}/write-draft`, { outline: outline.value, chapterTitle: chapterTitle.value || '新章' }, e => {
      if (e.event === 'beat') turnMeta.value = { beats: e.data.beats };
      if (e.event === 'content') draft.value = e.data;
      if (e.event === 'prose') draftMetrics.value = e.data;
    });
  } catch (err: any) { alert(err.message); }
  busy.value = false;
}
function captureSelection() {
  const el = editorEl.value;
  if (!el) return;
  selection.value = draft.value.slice(el.selectionStart, el.selectionEnd);
}
async function rewrite() {
  if (!selection.value || !rewriteInstruction.value || !active.value || busy.value) return;
  busy.value = true;
  try {
    await postSse(`/api/sessions/${active.value.id}/rewrite`, { draft: draft.value, selection: selection.value, instruction: rewriteInstruction.value }, e => {
      if (e.event === 'full') draft.value = e.data.text;
    });
    selection.value = '';
    rewriteInstruction.value = '';
  } catch (err: any) { alert(err.message); }
  busy.value = false;
}
async function finalizeToChapter() {
  if (!draft.value || !active.value) return;
  const work = active.value.workId;
  if (!work) { alert('该会话未绑定作品，请在创建时选择作品'); return; }
  const r = await api(`/api/works/${work}/chapters`, { method: 'POST', body: JSON.stringify({ title: chapterTitle.value || '新章' }) });
  await postSse(`/api/works/${work}/finalize`, {
    chapterId: (r as any).id, title: chapterTitle.value || '新章',
    index: 999, worldTime: 1000 + Math.random(), body: draft.value,
  }, () => {});
  alert('已定稿入库（事实提案进入审核队列）');
}
</script>

<template>
  <div>
    <div class="card">
      <h3>🎮 剧本包（穿书/原著线 · EntryRole · canon 硬跳）</h3>
      <div class="row" style="margin-bottom:8px">
        <select v-model="entryRole">
          <option value="protagonist">穿主角</option>
          <option value="supporting">穿配角</option>
          <option value="extra">路人视角</option>
          <option value="isekai">异世界来客</option>
        </select>
        <select v-model="playMode"><option value="mainline">主线（节点推进）</option><option value="free">自由</option></select>
        <span class="dimmer">内容分级自动 min(user, 包, 世界)</span>
      </div>
      <div class="row">
        <span v-for="pk in packList" :key="pk.id" class="tag" :class="{ ok: pk.playable?.ok }" style="cursor:pointer;padding:6px 12px" @click="startPack(pk)">
          📦 {{ pk.title }}<span v-if="!pk.playable?.ok" class="tag bad">不可玩</span>
        </span>
        <span v-if="!packList.length" class="dimmer">暂无剧本包</span>
      </div>
    </div>

    <div class="card">
      <h3>➕ 新会话</h3>
      <div class="row">
        <select v-model="worldId"><option value="" disabled>世界…</option><option v-for="w in worlds" :key="w.id" :value="w.id">{{ w.title }}</option></select>
        <select v-model="mode"><option value="rp">🎭 玩·角色扮演</option><option value="write">✍️ 写·章节创作</option></select>
        <select v-model="workId"><option value="">（不绑作品）</option><option v-for="w in works" :key="w.id" :value="w.id">《{{ w.title }}》</option></select>
        <input v-model="title" placeholder="标题">
        <template v-if="mode === 'rp'">
          <input v-model="charId" placeholder="我扮演（角色id，如 lin）" style="min-width:150px">
          <input v-model="focusCharId" placeholder="焦点NPC（可空）" style="min-width:130px">
        </template>
        <button class="primary" @click="createSession">创建</button>
      </div>
      <div class="dimmer" style="margin-top:6px">角色 id 见工作台「人物」页；扮演角色后 recall 自动按可见性过滤（防全知）</div>
    </div>

    <div class="card" v-if="sessions.length">
      <h3>会话列表</h3>
      <div class="row">
        <span v-for="s in sessions" :key="s.id" class="tag" style="cursor:pointer;font-size:12px;padding:4px 10px"
          :style="{ borderColor: active?.id === s.id ? 'var(--acc)' : undefined }"
          @click="openSession(s)">
          {{ s.mode === 'rp' ? '🎭' : '✍️' }} {{ s.title }}（{{ s.turnCount }} 轮）
          <span class="danger" @click.stop="delSession(s)">×</span>
        </span>
      </div>
    </div>

    <!-- RP -->
    <div v-if="active?.mode === 'rp'" class="chat">
      <div class="chat-log card">
        <div v-for="(t, i) in chatLog" :key="i" class="msg" :class="t.role">
          <div v-if="t.meta?.beats?.length" class="beat-box">🎬 {{ t.meta.beats.join(' → ') }}</div>
          {{ t.content }}
          <div class="meta" v-if="t.meta">
            <span v-if="t.meta.dice" class="tag">🎲 d20={{ t.meta.dice }}</span>
            <span v-if="t.meta.packMove" class="tag ok">📦 {{ t.meta.packMove.note }} → {{ t.meta.packMove.nodeId }}</span>
            <span v-if="t.meta.idle" class="tag warn">idle（下回合导演强制破局）</span>
            <span v-if="t.meta.prose" :class="['prose-badge', `prose-${t.meta.prose.verdict}`]">文风：{{ t.meta.prose.verdict }} · 词汇{{ t.meta.prose.lexicalDiversity }} · 句方差{{ t.meta.prose.sentenceLenVariance }} · AI腔{{ t.meta.prose.aiClicheDensity }}/千字</span>
            <span v-if="t.meta.proposal" class="tag">📥 {{ t.meta.proposal.deltas?.length ?? '?' }} 条事实提案进入审核队列</span>
          </div>
        </div>
        <div v-if="!chatLog.length" class="empty">输入第一句话开始演出。示例：「我推门而入，盯着沈青。」</div>
      </div>
      <div class="options" v-if="options.length">
        <button v-for="(o, i) in options" :key="o + i" @click="pick(o, i)">{{ o }}</button>
      </div>
      <div class="chat-input row">
        <textarea v-model="input" style="flex:1" placeholder="你的行动/台词…（Ctrl+Enter 发送）" @keydown.ctrl.enter="send"></textarea>
        <button class="primary" :disabled="busy" @click="send" style="align-self:flex-end">{{ busy ? '演出中…' : '发送' }}</button>
      </div>
    </div>

    <!-- 写作 -->
    <div v-else-if="active?.mode === 'write'">
      <div class="card">
        <h3>✍️ 章节创作（大纲 → beat → 草稿 → 圈改 → 定稿）</h3>
        <div class="row">
          <input v-model="chapterTitle" placeholder="章节标题" style="min-width:160px">
          <button class="primary" :disabled="busy" @click="writeDraft">{{ busy ? '生成中…' : '🎬 生成草稿' }}</button>
        </div>
        <textarea v-model="outline" style="margin-top:10px;min-height:90px" placeholder="本章大纲（发生了什么、信息如何揭示）"></textarea>
      </div>
      <div v-if="turnMeta?.beats?.length" class="card"><div class="beat-box">🎬 beat：{{ turnMeta.beats.join(' → ') }}</div></div>
      <div class="card" v-if="draft">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h3 style="margin:0">草稿</h3>
          <span v-if="draftMetrics" :class="['prose-badge', `prose-${draftMetrics.verdict}`]">{{ draftMetrics.verdict }} · AI腔 {{ draftMetrics.aiClicheDensity }}/千字</span>
          <button class="primary small" @click="finalizeToChapter">✅ 定稿入库</button>
        </div>
        <textarea ref="editorEl" v-model="draft" class="editor-area" @mouseup="captureSelection" @keyup="captureSelection"></textarea>
        <div v-if="selection" class="card" style="margin-top:10px">
          <div class="dimmer" style="margin-bottom:6px">已圈选 {{ selection.length }} 字，输入改写指令：</div>
          <div class="row">
            <input v-model="rewriteInstruction" style="flex:1" placeholder="如：更冷峻，删掉所有解释性句子">
            <button class="primary" :disabled="busy" @click="rewrite">局部重写</button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="empty">创建或选择一个会话开始</div>
  </div>
</template>
