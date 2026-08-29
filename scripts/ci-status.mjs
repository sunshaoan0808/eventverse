import { execFileSync } from 'node:child_process';
const GH = 'C:\\Users\\cs14ilike\\.zcode\\workspace\\default\\tools\\ghbin\\gh.exe';
const run = (a) => execFileSync(GH, ['api', ...a], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const runs = JSON.parse(run(['repos/sunshaoan0808/eventverse/actions/runs?per_page=1']));
const jobId = runs.workflow_runs[0].id;
const jobs = JSON.parse(run(['repos/sunshaoan0808/eventverse/actions/runs/' + jobId + '/jobs']));
const job = jobs.jobs[0];
console.log('== 步骤结论 ==');
for (const s of job.steps) console.log(`${s.name} → ${s.conclusion}`);
console.log('\n== 注解（check annotations）==');
try {
  const crs = JSON.parse(run(['repos/sunshaoan0808/eventverse/commits/ec45c46/check-runs']));
  for (const c of crs.check_runs ?? []) {
    console.log(`[${c.name}] ${c.conclusion} ${c.output?.title ?? ''}`);
    for (const a of c.output?.annotations_count ? [] : []) void a;
    const annUrl = c.output?.annotations_url;
    if (annUrl) {
      const ann = JSON.parse(run([annUrl.replace('https://api.github.com', '')]));
      for (const a of ann ?? []) console.log(`  · ${a.annotation_level}: ${a.message}`);
    }
  }
} catch (e) { console.log('ann err:', String(e.message).slice(0, 150)); }
