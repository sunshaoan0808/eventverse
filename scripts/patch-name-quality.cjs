// 一次性补丁：白名单升级为姓氏感知裁剪 + 角色词黑名单
const fs = require('node:fs');
const FILE = 'packages/engine/src/importer.ts';
let s = fs.readFileSync(FILE, 'utf8');

const OLD_START = s.indexOf('/** 人物名白名单：全书频次 + 前后缀黑名单');
const OLD_END = s.indexOf('export function buildSeedNames', OLD_START);
if (OLD_START < 0 || OLD_END < 0) { console.error('锚点未找到'); process.exit(1); }

const NEW = `/** 人物名白名单：全书频次 + 姓氏感知裁剪 + 角色词黑名单（防句式碎片与幻觉名）。LLM 与启发式共用。 */
const COMPOUND_SURNAMES = ['令狐', '欧阳', '慕容', '司徒', '诸葛', '司马', '上官', '皇甫', '长孙', '宇文', '尉迟', '赫连', '东方', '独孤', '南宫', '西门'];
const SINGLE_SURNAMES = new Set('李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文庞樊兰殷施陶洪翟安颜倪严牛温季章鲁葛伍韦申尤毕聂丛焦向柳邢路岳齐梅莫庄辛管祝左涂谷祁时舒耿牟卜詹关苗凌费纪靳盛童欧甄项曲成游裴席卫查屈鲍霍穆隋甘单包司宁蒲窦冉翁岑'.split('').filter(c => c));
const ROLE_NAMES = new Set(['师娘', '师父', '师傅', '师兄', '师姐', '师弟', '师妹', '老师', '同学', '大叔', '大姐', '大哥', '老二', '老三', '老大', '班长', '裁判', '校警', '老板', '经理', '老头', '新生', '兄弟', '记者', '司机', '医生', '门卫', '众人', '大家', '有人', '他们', '她们', '我们', '自己']);
const LEADING_BAD = /^[对着跟和与向给被让把冲朝找从往叫拉推带扶望看听想觉得令使他她它不没就还都也再到在说很太真好若便即就才只又候脱提低急心]/;
const TRAILING_BAD = /[知道经话了吗呢吧的就行去来在地说着了地得出而以之乎者只会都也还再又忙声里心快低娘]/;

/** 姓氏感知裁剪："他只对郭靖"式捕获 → "郭靖"；无姓氏依据 → null */
export function trimToSurname(cap: string): string | null {
  if (!cap || cap.length < 2) return null;
  for (const c of COMPOUND_SURNAMES) {
    const i = cap.lastIndexOf(c);
    if (i >= 0) { const name = cap.slice(i); if (name.length >= 2 && name.length <= 4) return name; }
  }
  let best: string | null = null;
  for (let i = 0; i < cap.length - 1; i++) {
    if (SINGLE_SURNAMES.has(cap[i])) {
      const name = cap.slice(i);
      if (name.length <= 3) best = name;
    }
  }
  return best;
}

export function isPlausibleCharName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 4) return false;
  if (ROLE_NAMES.has(name) || LEADING_BAD.test(name) || TRAILING_BAD.test(name)) return false;
  return trimToSurname(name) === name;
}

export function collectCharCandidates(text: string): string[] {
  const out = new Set<string>();
  const pat = /([\\u4e00-\\u9fa5]{2,4})(?:说|道|问|喊)(?=\\s*[:：“"])/g;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(text)) !== null) {
    const name = trimToSurname(m[1]);
    if (name && isPlausibleCharName(name)) out.add(name);
  }
  return [...out];
}

`;

s = s.slice(0, OLD_START) + NEW + s.slice(OLD_END);
fs.writeFileSync(FILE, s);
console.log('patched');
