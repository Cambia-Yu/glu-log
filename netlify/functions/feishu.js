// Netlify Function：飞书多维表格代理（/api/* 经 redirects 转到本函数）
// 环境变量（Netlify 站点设置里配置）：
//   FEISHU_APP_ID / FEISHU_APP_SECRET  （飞书应用凭据）
//   BASE_TOKEN / TABLE_ID               （多维表格，可选，有默认值）
const FEISHU = 'https://open.feishu.cn';
const BASE_TOKEN = process.env.BASE_TOKEN || 'HSb2bGv9SaNVSqs8ZyScn60EnLc';
const TABLE_ID = process.env.TABLE_ID || 'tblFWF4yxapyEXBe';
const TABLE_URL = 'https://my.feishu.cn/base/HSb2bGv9SaNVSqs8ZyScn60EnLc';

const SELECT_FIELDS = ['餐次', '数据来源', '升糖风险', '主要食物'];
const NUMBER_FIELDS = ['碳水估算(g)', '热量估算(kcal)', '餐前血糖', '餐后30分', '餐后1小时', '餐后2小时', '餐后3小时'];
const DATE_FIELDS = ['日期'];
const DATETIME_FIELDS = ['用餐时间'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let _token = null, _tokenAt = 0;
async function tenantToken() {
  if (_token && Date.now() - _tokenAt < 5400000) return _token;
  const r = await fetch(FEISHU + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  });
  const j = await r.json();
  if (!j.tenant_access_token) throw new Error('飞书鉴权失败: ' + (j.msg || j.code));
  _token = j.tenant_access_token; _tokenAt = Date.now();
  return _token;
}
async function feishu(path, init = {}) {
  const token = await tenantToken();
  const r = await fetch(FEISHU + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('飞书接口错误 ' + j.code + ': ' + j.msg);
  return j.data;
}
const toMs = v => (v ? new Date(v).getTime() : null);
function normalize(rec) {
  const f = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) continue;
    if (SELECT_FIELDS.includes(k)) { const s = Array.isArray(v) ? v[0] : v; if (s !== undefined && s !== null && s !== '') f[k] = s; }
    else if (NUMBER_FIELDS.includes(k)) { const n = parseFloat(v); if (!isNaN(n)) f[k] = n; }
    else if (DATE_FIELDS.includes(k)) { const ms = toMs(v); if (ms) f[k] = ms; }
    else if (DATETIME_FIELDS.includes(k)) { const ms = toMs(v); if (ms) f[k] = ms; }
    else f[k] = v;
  }
  const date = String(rec['日期'] || '').slice(0, 10);
  const meal = Array.isArray(rec['餐次']) ? rec['餐次'][0] : rec['餐次'];
  if (date && meal) f['餐次标签'] = `${date} ${meal}`;
  return f;
}
const ok = (data, status = 200) => ({ statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }, body: JSON.stringify(data) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    const rawPath = event.path || '';
    const m = rawPath.match(/\/api([^?]*)/);
    const route = m ? m[1] : '';
    let body = {};
    if (event.body) body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);

    if (route === '/config') return ok({ base_url: TABLE_URL, table_name: '餐次记录' });
    if (route === '/records') {
      if (event.httpMethod === 'POST') {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const rows = (body.records || []).map(r => {
          r = { ...r };
          if (!r['数据来源']) r['数据来源'] = '手动录入';
          if (!r['日期']) r['日期'] = today;
          return normalize(r);
        });
        const data = await feishu(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/batch_create`, {
          method: 'POST', body: JSON.stringify({ records: rows.map(fields => ({ fields })) }),
        });
        return ok({ ok: true, count: (data.records || []).length, record_ids: (data.records || []).map(x => x.record_id) });
      }
      if (event.httpMethod === 'GET') {
        let items = [], token;
        do {
          const q = new URLSearchParams({ page_size: '500', ...(token ? { page_token: token } : {}) });
          const d = await feishu(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?${q}`);
          items = items.concat(d.items || []);
          token = d.has_more ? d.page_token : null;
        } while (token);
        items.sort((a, b) => {
          const da = Array.isArray(a.fields['日期']) ? a.fields['日期'][0] : a.fields['日期'];
          const db = Array.isArray(b.fields['日期']) ? b.fields['日期'][0] : b.fields['日期'];
          return (typeof db === 'number' ? db : 0) - (typeof da === 'number' ? da : 0);
        });
        return ok({ ok: true, count: items.length, records: items.map(x => ({ record_id: x.record_id, fields: x.fields })) });
      }
    }
    const ridM = route.match(/^\/records\/([\w-]+)$/);
    if (ridM && event.httpMethod === 'PATCH') {
      const fields = normalize(body.fields || {});
      await feishu(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/batch_update`, {
        method: 'POST', body: JSON.stringify({ records: [{ record_id: ridM[1], fields }] }),
      });
      return ok({ ok: true, record_id: ridM[1] });
    }
    return ok({ ok: false, error: '404 ' + route }, 404);
  } catch (e) {
    return ok({ ok: false, error: e.message }, 500);
  }
};
