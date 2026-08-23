<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../api';

const providers = ref<any[]>([]);
const saved = ref(false);

onMounted(async () => {
  const r = await api('/api/settings');
  providers.value = r.providers;
});

function addProvider() {
  providers.value.push({ id: `p-${Date.now().toString(36)}`, protocol: 'openai', baseUrl: '', apiKey: '', model: '', role: 'renderer' });
}

async function save() {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ providers: providers.value }) });
  const r = await api('/api/settings');
  providers.value = r.providers;
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}
</script>

<template>
  <div>
    <div class="card">
      <h3>⚙️ 模型供应商（双协议：OpenAI Chat Completions / Anthropic Messages）</h3>
      <div class="dimmer" style="margin-bottom:10px">
        五个角色独立配置：渲染（强模型）· 导演/对抗审（便宜模型）· 抽取（最廉）。未配置时全部走内置 mock 引擎（离线演示可用，不产生真实调用）。
        兼容任意 OpenAI 协议端点（DeepSeek / Kimi / GLM / Ollama 等），填 base URL 到 /v1 即可。
        API Key 使用 AES-256-GCM 加密落盘（master.key 在数据目录）。
      </div>
      <table>
        <tr><th>角色</th><th>协议</th><th>Base URL</th><th>模型</th><th>API Key</th><th></th></tr>
        <tr v-for="(p, i) in providers" :key="p.id">
          <td>
            <select v-model="p.role">
              <option value="renderer">renderer 渲染</option>
              <option value="director">director 导演</option>
              <option value="extractor">extractor 抽取</option>
              <option value="adversarial">adversarial 对抗审</option>
              <option value="chat">chat</option>
            </select>
          </td>
          <td>
            <select v-model="p.protocol">
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="mock">mock（离线）</option>
            </select>
          </td>
          <td><input v-model="p.baseUrl" placeholder="https://api.deepseek.com/v1" style="width:100%;min-width:200px"></td>
          <td><input v-model="p.model" placeholder="deepseek-chat" style="min-width:130px"></td>
          <td><input v-model="p.apiKey" :placeholder="p.hasKey ? '（已保存，留空保持不变）' : 'sk-…'" type="password" style="min-width:150px"></td>
          <td><button class="small danger" @click="providers.splice(i, 1)">×</button></td>
        </tr>
      </table>
      <div class="row" style="margin-top:10px">
        <button @click="addProvider">+ 添加</button>
        <button class="primary" @click="save">{{ saved ? '✓ 已保存' : '保存配置' }}</button>
      </div>
    </div>
    <div class="card">
      <h3>ℹ️ 关于</h3>
      <div class="dimmer">
        EventVerse v1.0 —— 事件溯源世界状态 + 可见性谓词 + 对抗审漏斗 + 双 agent 回合引擎。<br>
        数据全部保存在本地数据目录（默认 ./data），密钥加密存储，不上传任何内容到第三方（仅调用你配置的 LLM API）。
      </div>
    </div>
  </div>
</template>
