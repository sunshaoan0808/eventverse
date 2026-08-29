// 一次性补丁：姓氏表扩充 + 高频虚构名二次机会
const fs = require('node:fs');
const FILE = 'packages/engine/src/importer.ts';
let s = fs.readFileSync(FILE, 'utf8');

// 1) 复姓表加 完颜 等
s = s.replace(
  "['令狐', '欧阳', '慕容', '司徒', '诸葛', '司马', '上官', '皇甫', '长孙', '宇文', '尉迟', '赫连', '东方', '独孤', '南宫', '西门']",
  "['令狐', '欧阳', '慕容', '司徒', '诸葛', '司马', '上官', '皇甫', '长孙', '宇文', '尉迟', '赫连', '东方', '独孤', '南宫', '西门', '完颜', '呼延', '闻人']"
);

// 2) 单姓表补 丘/虚
s = s.replace('阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦', '阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦丘虚');

// 3) 尾字黑名单去掉 之/子（林平之/施戴子 是真名），换入确证碎片尾字
s = s.replace(
  '/[知道经话了吗呢吧的就行去来在地说着了地得出而以之乎者只会都也还再又忙声快低娘]/',
  '/[知道经话了吗呢吧的就行去来在地说着了地得出而以乎者只会都也还再又忙声快低娘忽赶然原先便]/'
);

// 4) isPlausibleCharName 加 fullText 高频二次机会（虚构名如 虚竹/阿朱/劳德诺）
const fnOld = `export function isPlausibleCharName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 4) return false;
  if (ROLE_NAMES.has(name) || LEADING_BAD.test(name) || TRAILING_BAD.test(name)) return false;
  return trimToSurname(name) === name;
}`;
const fnNew = `export function isPlausibleCharName(name: string, fullText?: string): boolean {
  if (!name || name.length < 2 || name.length > 4) return false;
  if (ROLE_NAMES.has(name) || LEADING_BAD.test(name) || TRAILING_BAD.test(name)) return false;
  if (trimToSurname(name) === name) return true;
  // 非常见姓氏的虚构名（虚竹/阿朱/劳德诺）：全书高频出现则认可
  if (fullText && fullText.split(name).length - 1 >= 10) return true;
  return false;
}`;
if (!s.includes(fnOld)) { console.error('函数锚点未找到'); process.exit(1); }
s = s.replace(fnOld, fnNew);

// 5) buildSeedNames 用新判定（strict 过不了但高频的也收）
s = s.replace(
  "if (LEADING_BAD.test(name) || TRAILING_BAD.test(name)) continue;\n    if (text.split(name).length - 1 < minFreq) continue;",
  "if (!isPlausibleCharName(name, text)) continue;\n    if (text.split(name).length - 1 < Math.min(minFreq, 3)) continue;"
);

fs.writeFileSync(FILE, s);
console.log('patched OK');
