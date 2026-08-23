<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from './api';
import WorldList from './views/WorldList.vue';
import Workbench from './views/Workbench.vue';
import Sessions from './views/Sessions.vue';
import Settings from './views/Settings.vue';
import WorldQA from './views/WorldQA.vue';

const view = ref<'worlds' | 'workbench' | 'sessions' | 'qa' | 'settings'>('worlds');
const worlds = ref<any[]>([]);
const activeWorld = ref<string>('');
const health = ref<any>(null);

async function refreshWorlds() {
  worlds.value = await api('/api/worlds');
  if (!activeWorld.value && worlds.value.length) activeWorld.value = worlds.value[0].id;
}

function openWorld(id: string) { activeWorld.value = id; view.value = 'workbench'; }

onMounted(async () => {
  try { health.value = await api('/api/health'); } catch { health.value = { ok: false }; }
  await refreshWorlds();
});
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><img src="/icon.svg">EventVerse 叙界</div>
      <div class="nav-item" :class="{ active: view === 'worlds' }" @click="view = 'worlds'">🏠 书架</div>
      <div class="nav-item" :class="{ active: view === 'workbench' }" @click="view = 'workbench'">📖 世界工作台</div>
      <div class="nav-item" :class="{ active: view === 'sessions' }" @click="view = 'sessions'">💬 会话（玩/写）</div>
      <div class="nav-item" :class="{ active: view === 'qa' }" @click="view = 'qa'">🔎 世界问答</div>
      <div class="nav-item" :class="{ active: view === 'settings' }" @click="view = 'settings'">⚙️ 模型设置</div>
      <div class="nav-group">世界</div>
      <div v-for="w in worlds" :key="w.id" class="nav-item" :class="{ active: activeWorld === w.id && view === 'workbench' }"
        @click="openWorld(w.id)">· {{ w.title }}</div>
      <div style="margin-top:20px" class="dimmer">
        {{ health?.ok ? '✓ 服务在线' : '✗ 服务离线' }}
      </div>
    </aside>
    <main class="main">
      <WorldList v-if="view === 'worlds'" :worlds="worlds" @refresh="refreshWorlds" @open="openWorld" />
      <Workbench v-else-if="view === 'workbench'" :world-id="activeWorld" :worlds="worlds" @refresh="refreshWorlds" />
      <Sessions v-else-if="view === 'sessions'" :worlds="worlds" />
      <WorldQA v-else-if="view === 'qa'" :worlds="worlds" />
      <Settings v-else />
    </main>
  </div>
</template>
