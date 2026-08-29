<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';

const props = defineProps<{ worlds: any[] }>();
const emit = defineEmits<{ refresh: []; open: [id: string] }>();
const newTitle = ref('');
const works = ref<any[]>([]);
const selectedWorld = ref('');
const importTitle = ref('');
const importText = ref('');
const importYear = ref(1000);
const importBusy = ref(false);
const jobId = ref('');
const jobState = ref<any>(null);
const stJson = ref('');
const stBusy = ref(false);
const stFileName = ref('');
let stPngB64 = '';
const wbJson = ref('');
const wbBusy = ref(false);
const wbWorld = ref('');

async function onStFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  stFileName.value = f.name;
  if (f.name.toLowerCase().endsWith('.png')) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    stPngB64 = btoa(bin);
    stJson.value = '';
  } else {
    stJson.value = await f.text();
    stPngB64 = '';
  }
}

async function importStCard() {
  if (!selectedWorld.value) { alert('先选择世界'); return; }
  if (!stJson.value.trim() && !stPngB64) { alert('选择角色卡文件（.png/.json）或粘贴 JSON'); return; }
  stBusy.value = true;
  try {
    const body: any = { worldId: selectedWorld.value, worldTime: 1000 };
    if (stPngB64) body.pngBase64 = stPngB64;
    else body.card = JSON.parse(stJson.value);
    const r = await api('/api/import/st-card', { method: 'POST', body: JSON.stringify(body) });
    alert(`已导入角色：${(r as any).name}（+${(r as any).facts} 条世界书）`);
    stJson.value = ''; stPngB64 = ''; stFileName.value = '';
  } catch (e: any) { alert('导入失败：' + e.message); }
  stBusy.value = false;
}

// 开书向导（Session Zero，MD §5.3）
const wizStep = ref(1);
const wiz = ref({ worldTitle: '', era: '', baseYear: 1000, guidance: '', characters: [] as any[], relations: [] as any[], facts: [] as any[] });
const wizBusy = ref(false);
const wizDone = ref<{ worldId: string; events: number; chars: number } | null>(null);
const wizError = ref('');

function wizAddChar() { wiz.value.characters.push({ name: '', gender: '', desc: '', place: '' }); }
function wizAddRel() { wiz.value.relations.push({ from: '', to: '', type: '', secret: false }); }
function wizAddFact() { wiz.value.facts.push({ key: '', value: '' }); }

async function wizSubmit() {
  wizBusy.value = true;
  wizError.value = '';
  try {
    const r = await api('/api/wizard', {
      method: 'POST',
      body: JSON.stringify({
        worldTitle: wiz.value.worldTitle, era: wiz.value.era, baseYear: Number(wiz.value.baseYear), guidance: wiz.value.guidance,
        characters: wiz.value.characters.filter(c => c.name.trim()),
        relations: wiz.value.relations.filter(r => r.from && r.to),
        facts: wiz.value.facts.filter(f => f.key),
      }),
    });
    emit('refresh');
    wizDone.value = { worldId: (r as any).worldId, events: (r as any).events, chars: (r as any).chars };
    wizStep.value = 1;
    wiz.value = { worldTitle: '', era: '', baseYear: 1000, guidance: '', characters: [], relations: [], facts: [] };
  } catch (e: any) { wizDone.value = null; wizError.value = '向导失败：' + e.message; }
  wizBusy.value = false;
}

async function importWorldbook() {
  if (!wbJson.value.trim() || !wbWorld.value) { alert('选择世界并粘贴世界书 JSON'); return; }
  wbBusy.value = true;
  try {
    const book = JSON.parse(wbJson.value);
    const r = await api('/api/import/worldbook', { method: 'POST', body: JSON.stringify({ worldId: wbWorld.value, book }) });
    alert(`导入 ${(r as any).imported} 条（跳过 ${(r as any).skipped} 条停用项）`);
    wbJson.value = '';
  } catch (e: any) { alert('导入失败：' + e.message); }
  wbBusy.value = false;
}

async function loadWorks(worldId: string) {
  selectedWorld.value = worldId;
  works.value = await api(`/api/works?worldId=${worldId}`);
}
if (props.worlds.length) loadWorks(props.worlds[0].id);

async function createWorld() {
  if (!newTitle.value.trim()) return;
  await api('/api/worlds', { method: 'POST', body: JSON.stringify({ title: newTitle.value }) });
  newTitle.value = '';
  emit('refresh');
}

async function importNovel() {
  if (!importText.value.trim() || !selectedWorld.value) return;
  importBusy.value = true;
  const r = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({ worldId: selectedWorld.value, title: importTitle.value || '导入作品', text: importText.value, baseYear: Number(importYear.value), llmChapterBudget: 0 }),
  });
  jobId.value = (r as any).jobId;
  pollJob();
}

async function pollJob() {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    jobState.value = await api(`/api/jobs/${jobId.value}`);
    if (['done', 'error', 'cancelled'].includes(jobState.value.status)) {
      importBusy.value = false;
      if (selectedWorld.value) loadWorks(selectedWorld.value);
      return;
    }
  }
}

function exportWb() {
  if (!selectedWorld.value) return;
  window.open(`/api/worlds/${selectedWorld.value}/export/worldbook`, '_blank');
}
</script>

<template>
  <div>
    <div class="card">
      <h3>🧙 开书向导 · Session Zero（15 分钟从零建出可用世界）</h3>
      <div class="tabs">
        <div class="tab" :class="{ active: wizStep === 1 }" @click="wizStep = 1">① 世界骨架</div>
        <div class="tab" :class="{ active: wizStep === 2 }" @click="wizStep = 2">② 核心人物</div>
        <div class="tab" :class="{ active: wizStep === 3 }" @click="wizStep = 3">③ 关系与设定</div>
        <div class="tab" :class="{ active: wizStep === 4 }" @click="wizStep = 4">④ 完成</div>
      </div>
      <div v-if="wizStep === 1">
        <div class="row">
          <input v-model="wiz.worldTitle" placeholder="世界名，如：九州">
          <input v-model="wiz.baseYear" style="min-width:100px" placeholder="开篇年">
          <input v-model="wiz.era" style="flex:1" placeholder="纪元/时代一句话，如：旧朝倾覆，群雄割据">
        </div>
        <div class="row" style="margin-top:8px"><input v-model="wiz.guidance" style="flex:1" placeholder="文风期望（可选），如：冷峻短句"></div>
        <button class="primary" style="margin-top:10px" @click="wizStep = 2">下一步 →</button>
      </div>
      <div v-else-if="wizStep === 2">
        <div v-for="(c, i) in wiz.characters" :key="i" class="row" style="margin-bottom:6px">
          <input v-model="c.name" placeholder="姓名" style="min-width:100px">
          <input v-model="c.gender" placeholder="性别" style="min-width:70px">
          <input v-model="c.desc" placeholder="一句话简介" style="flex:1">
          <input v-model="c.place" placeholder="初始位置" style="min-width:110px">
          <button class="small danger" @click="wiz.characters.splice(i, 1)">×</button>
        </div>
        <div class="row"><button class="small" @click="wizAddChar">+ 人物</button><button class="primary" style="margin-left:auto" @click="wizStep = 3">下一步 →</button></div>
      </div>
      <div v-else-if="wizStep === 3">
        <div v-for="(r, i) in wiz.relations" :key="'r' + i" class="row" style="margin-bottom:6px">
          <input v-model="r.from" placeholder="甲" style="min-width:90px"> —
          <input v-model="r.type" placeholder="关系" style="min-width:90px"> →
          <input v-model="r.to" placeholder="乙" style="min-width:90px">
          <label class="dimmer"><input type="checkbox" v-model="r.secret"> 秘密（仅双方知情）</label>
          <button class="small danger" @click="wiz.relations.splice(i, 1)">×</button>
        </div>
        <div class="row"><button class="small" @click="wizAddRel">+ 关系</button></div>
        <div v-for="(f, i) in wiz.facts" :key="'f' + i" class="row" style="margin-bottom:6px">
          <input v-model="f.key" placeholder="设定名，如：王朝" style="min-width:110px"> =
          <input v-model="f.value" placeholder="内容" style="flex:1">
          <button class="small danger" @click="wiz.facts.splice(i, 1)">×</button>
        </div>
        <div class="row"><button class="small" @click="wizAddFact">+ 设定</button><button class="primary" style="margin-left:auto" @click="wizStep = 4">下一步 →</button></div>
      </div>
      <div v-else>
        <div class="dimmer">
          《{{ wiz.worldTitle || '未命名' }}》：{{ wiz.characters.filter(c => c.name).length }} 位人物、{{ wiz.relations.filter(r => r.from && r.to).length }} 组关系、{{ wiz.facts.filter(f => f.key).length }} 条设定。
          建成后时间轴/关系图/一致性扫描即刻可用。
        </div>
        <button class="primary" style="margin-top:10px" :disabled="wizBusy" @click="wizSubmit">{{ wizBusy ? '建造中…' : '🏗 建造世界' }}</button>
      </div>
      <div class="row" style="margin-top:10px" v-if="wizDone || wizError">
        <span v-if="wizDone" class="tag ok">✓ 世界已就绪（{{ wizDone.events }} 事件 / {{ wizDone.chars }} 人物）
          <a style="cursor:pointer" @click="emit('open', wizDone!.worldId)">进入工作台 →</a>
        </span>
        <span v-if="wizError" class="tag bad">{{ wizError }}</span>
      </div>
    </div>

    <div class="card">
      <h3>🌍 世界（一个世界 = 一个事件流底座，可多作品共享）</h3>
      <div class="row">
        <input v-model="newTitle" placeholder="新世界名称，如：九州" @keyup.enter="createWorld">
        <button class="primary" @click="createWorld">创建世界</button>
      </div>
      <table style="margin-top:10px">
        <tr><th>世界</th><th>ID</th><th>操作</th></tr>
        <tr v-for="w in worlds" :key="w.id">
          <td>{{ w.title }}</td><td class="mono">{{ w.id }}</td>
          <td><button class="small" @click="emit('open', w.id)">进入工作台 →</button></td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h3>📥 拆书导入（切章 → 时间归位 → 抽取 → 对抗审漏斗）</h3>
      <div class="row">
        <select v-model="selectedWorld" @change="loadWorks(selectedWorld)">
          <option v-for="w in worlds" :key="w.id" :value="w.id">{{ w.title }}</option>
        </select>
        <input v-model="importTitle" placeholder="书名">
        <input v-model="importYear" style="min-width:90px" title="开篇对应的世界年">
        <button class="primary" :disabled="importBusy" @click="importNovel">{{ importBusy ? '拆书中…' : '导入 TXT' }}</button>
        <button @click="exportWb">导出世界书(ST)</button>
      </div>
      <textarea v-model="importText" style="margin-top:10px;min-height:120px" placeholder="粘贴小说全文（支持 第X章/楔子/Chapter 切章，无标记按字数窗降级）"></textarea>
      <div v-if="jobState" class="dimmer" style="margin-top:8px">
        任务：{{ jobState.label }} · {{ jobState.status }} · {{ jobState.progress }}/{{ jobState.total }}
        <span v-if="jobState.status==='done'">✓ 产生 {{ jobState.result?.proposals ?? 0 }} 个待审提案</span>
      </div>
    </div>

    <div class="card">
      <h3>🃏 导入 SillyTavern 角色卡（PNG / v2 / v3 JSON，含内嵌世界书）</h3>
      <div class="row">
        <select v-model="selectedWorld"><option value="" disabled>选择世界…</option><option v-for="w in worlds" :key="w.id" :value="w.id">{{ w.title }}</option></select>
        <label style="cursor:pointer">
          <input type="file" accept=".png,.json" style="display:none" @change="onStFile">
          <span class="tag" style="padding:6px 12px">📁 {{ stFileName || '选择角色卡文件（PNG/JSON）' }}</span>
        </label>
        <button class="primary" :disabled="stBusy" @click="importStCard">{{ stBusy ? '导入中…' : '导入角色卡' }}</button>
      </div>
      <textarea v-model="stJson" style="min-height:70px;margin-top:8px" placeholder="或直接粘贴角色卡 JSON"></textarea>
    </div>

    <div class="card">
      <h3>📚 导入独立世界书（ST entries JSON，与导出对称）</h3>
      <div class="row">
        <select v-model="wbWorld"><option value="" disabled>选择世界…</option><option v-for="w in worlds" :key="w.id" :value="w.id">{{ w.title }}</option></select>
        <label style="cursor:pointer">
          <input type="file" accept=".json" style="display:none" @change="onWbFile">
          <span class="tag" style="padding:6px 12px">📁 选择世界书 JSON 文件</span>
        </label>
        <span class="dimmer">支持 ST 标准导出与裸 entries 格式；constant 条目入库为 lore:设定</span>
      </div>
      <textarea v-model="wbJson" style="min-height:70px;margin-top:8px" placeholder='或粘贴：{"entries": {...}} / 裸 entries 对象 / 数组'></textarea>
      <div class="row" style="margin-top:8px">
        <button class="primary" :disabled="wbBusy" @click="importWorldbook">{{ wbBusy ? '导入中…' : '导入世界书' }}</button>
      </div>
    </div>

    <div class="card" v-if="works.length">
      <h3>📚 {{ worlds.find(w => w.id === selectedWorld)?.title }} 的作品</h3>
      <table>
        <tr><th>作品</th><th>创建于</th><th></th></tr>
        <tr v-for="w in works" :key="w.id">
          <td>{{ w.title }}</td><td class="dimmer">{{ w.created_at?.slice(0, 10) }}</td>
          <td><button class="small" @click="emit('open', selectedWorld)">工作台 →</button></td>
        </tr>
      </table>
    </div>
  </div>
</template>
