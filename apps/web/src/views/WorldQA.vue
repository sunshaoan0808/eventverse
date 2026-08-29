<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, postSse } from '../api';

const props = defineProps<{ worlds: any[] }>();
const worldId = ref('');
const question = ref('');
const busy = ref(false);
const log = ref<any[]>([]);

onMounted(() => { if (props.worlds.length) worldId.value = props.worlds[0].id; });

async function ask() {
  const q = question.value.trim();
  if (!q || !worldId.value || busy.value) return;
  question.value = '';
  busy.value = true;
  log.value.push({ role: 'user', content: q });
  const live: any = { role: 'assistant', content: '', tools: [] };
  log.value.push(live);
  try {
    await postSse('/api/chat', { worldId: worldId.value, message: q }, e => {
      if (e.event === 'tool') live.tools.push(`🔧 ${e.data.name}`);
      if (e.event === 'tool_result') live.tools.push(`✓ ${e.data.name}`);
      if (e.event === 'content') live.content = e.data;
      if (e.event === 'error') live.content = `⚠️ ${e.data.message ?? '查询失败'}`;
      if (e.event === 'done') live.budget = e.data.budgetExhausted ? '工具预算用尽' : null;
      log.value = [...log.value];
    });
  } catch (err: any) {
    live.content = `⚠️ ${err.message}`;
  }
  busy.value = false;
  log.value = [...log.value];
}
</script>

<template>
  <div>
    <div class="card">
      <h3>🔎 世界问答（读侧 agent：story_index / read / grep / search / recall 自由调用，≤12 次）</h3>
      <div class="row">
        <select v-model="worldId">
          <option v-for="w in worlds" :key="w.id" :value="w.id">{{ w.title }}</option>
        </select>
        <input v-model="question" style="flex:1" placeholder="问这个世界任何事，如：林澜现在在哪？她和沈青是什么关系？" @keyup.enter="ask">
        <button class="primary" :disabled="busy" @click="ask">{{ busy ? '查询中…' : '提问' }}</button>
      </div>
      <div class="dimmer" style="margin-top:6px">AI 只能读不能写——所有检索按可见性过滤；对世界的修改永远走审核漏斗。</div>
    </div>
    <div class="chat-log card">
      <div v-for="(m, i) in log" :key="i" class="msg" :class="m.role">
        <div v-if="m.tools?.length" class="dimmer" style="margin-bottom:4px">🔧 {{ m.tools.join(' → ') }}</div>
        {{ m.content }}
      </div>
      <div v-if="!log.length" class="empty">示例问题：「第三章发生了什么？」「谁和谁有旧识关系？」「南川布防图的伏笔埋在哪？」</div>
    </div>
  </div>
</template>
