import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const sourcePath = process.argv[2];
if (!sourcePath) { console.error('Uso: npm run import-conversions -- .\\reporte.csv'); process.exit(1); }
const dbPath = new URL('../data/db.json', import.meta.url);
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const parseCsv = (content) => {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const parseLine = (line) => { const result=[]; let value='', quoted=false; for (let i=0;i<line.length;i++) { const char=line[i]; if (char==='"') { if (quoted && line[i+1]==='"') { value+='"'; i++; } else quoted=!quoted; } else if (char===',' && !quoted) { result.push(value.trim()); value=''; } else value+=char; } result.push(value.trim()); return result; };
  const headers = parseLine(lines.shift()).map(value => value.toLowerCase());
  return lines.map(line => Object.fromEntries(parseLine(line).map((value,index) => [headers[index], value])));
};
let data;
try { data = JSON.parse(await readFile(dbPath, 'utf8')); }
catch { console.error('No existe data/db.json. Inicia Ndivepa una vez antes de importar.'); process.exit(1); }
const rows = parseCsv(await readFile(sourcePath, 'utf8'));
const required = ['network_conversion_id', 'product_id', 'commission'];
if (!rows.length || required.some(name => !(name in rows[0]))) { console.error(`CSV inválido. Encabezados requeridos: ${required.join(', ')}`); process.exit(1); }
const batchId = id('import'); const result = { imported: 0, skipped: 0, errors: [] };
for (const [index, row] of rows.entries()) {
  const conversionId = row.network_conversion_id;
  const product = data.affiliateProducts.find(item => item.id === row.product_id);
  if (!conversionId || !product) { result.skipped++; result.errors.push(`Fila ${index + 2}: falta ID de red o producto inexistente.`); continue; }
  if (data.conversions.some(item => item.networkConversionId === conversionId)) { result.skipped++; result.errors.push(`Fila ${index + 2}: conversión ${conversionId} ya existe.`); continue; }
  const program = data.programs.find(item => item.id === product.programId);
  const status = ['detected','pending','approved','confirmed','rejected','reversed','paid'].includes(row.status) ? row.status : 'pending';
  const conversion = { id:id('conv'), networkConversionId:conversionId, clickId:row.click_id || null, productId:product.id, merchantId:product.merchantId, networkId:program?.networkId || null, date:row.date || now(), type:row.type || 'purchase', saleAmount:Number(row.sale_amount || 0), saleCurrency:row.sale_currency || 'USD', commission:Number(row.commission), commissionCurrency:row.commission_currency || 'USD', status, source:'import_csv', importBatchId:batchId };
  const commissionStatus = status === 'paid' ? 'paid' : ['approved','confirmed'].includes(status) ? 'approved' : status === 'reversed' ? 'reversed' : status === 'rejected' ? 'rejected' : 'pending';
  data.conversions.unshift(conversion);
  data.commissions.unshift({ id:id('com'), conversionId:conversion.id, productId:product.id, amount:conversion.commission, currency:conversion.commissionCurrency, status:commissionStatus, payableAt:null, paidAt:status === 'paid' ? now() : null });
  result.imported++;
}
data.imports.unshift({ id:batchId, type:'conversion_csv', sourcePath, importedAt:now(), ...result });
data.audits.unshift({ id:id('audit'), userId:'system', timestamp:now(), ip:null, action:'conversion_csv_imported', entity:'importBatch', before:null, after:{ batchId, imported:result.imported, skipped:result.skipped } });
await writeFile(dbPath, JSON.stringify(data, null, 2));
console.log(`Importación finalizada: ${result.imported} importada(s), ${result.skipped} omitida(s).`);
if (result.errors.length) console.log(result.errors.join('\n'));
