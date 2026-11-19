import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { DEFAULTS } from "../config.js";
import { rmSync } from "node:fs";
import { openStorage, type Storage } from "../storage.js";
import { installPricing, reportCsv, resolveReportScope, updateProject, usageReport, zonedMidnight } from "../report.js";
import { PRICING } from "../pricing.js";
import { testConfig } from "./helpers.js";
const stores: Storage[] = [], dirs: string[] = [];
const noon = Date.parse("2026-09-25T03:00:00Z");
const dayStart = Date.parse("2026-09-24T15:00:00Z");
async function store() {
  const c = testConfig(); dirs.push(c.dataDir); const s = await openStorage(c); stores.push(s);
  s.db.prepare("INSERT INTO project VALUES('alpha','Alpha',NULL)").run();
  s.db.prepare("INSERT INTO workspace VALUES('wa',?,'/test/alpha',NULL,'alpha','manual'),('wu',?,'/test/unassigned',NULL,NULL,'unassigned')").run(s.deviceId,s.deviceId);
  s.db.exec("UPDATE collector_scan SET state='watching',last_scan_at=1,source_count=2 WHERE id=1");
  installPricing(s.db); return s;
}
function usage(s: Storage, id: string, values: Record<string, unknown> = {}) {
  const v = { id, device_id: s.deviceId, provider_id: "claude-code", response_id: id, model: "claude-sonnet-4-6", first_event_at: dayStart + 1, snapshot_at: dayStart + 1,
    workspace_id: "wa", input_tokens: 100n, output_tokens: 50n, cache_read_tokens: 800n, cache_write_tokens: 200n, cache_write_5m: 150n, cache_write_1h: 50n,
    validity: "valid", cost_eligibility: "eligible", parser_version: "independent-fixture", ...values };
  s.db.prepare(`INSERT INTO usage_record(${Object.keys(v).join(",")}) VALUES(${Object.keys(v).map(() => "?").join(",")})`).run(...Object.values(v));
}
const query = (s: Storage, input = {}) => usageReport(s.db, { period: "today", asOf: noon, ...input }, noon);
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(p => rmSync(p,{recursive:true,force:true})); delete PRICING.rates["fixture-model"]; });
describe("calendar scope independent contract", () => {
  it("matches published Seoul today/7/30 boundaries", () => {
    for (const [period, from] of [["today","2026-09-24T15:00:00Z"],["7","2026-09-18T15:00:00Z"],["30","2026-08-26T15:00:00Z"]]) {
      const s = resolveReportScope({period,asOf:noon,timezone:"Asia/Seoul"},noon); expect(s.from).toBe(Date.parse(from!)); expect(s.to).toBe(noon);
    }
  });
  it("uses 23/25h DST calendar days and includes the user end date", () => {
    for (const [date,hours] of [["2026-03-08",23],["2026-11-01",25]] as const) {
      const s = resolveReportScope({period:"custom",from:date,to:date,timezone:"America/New_York"},Date.parse("2027-01-01T00:00:00Z"));
      expect(s.to-s.from).toBe(hours*3600000);
    }
    expect(zonedMidnight("2026-03-09","America/New_York")-zonedMidnight("2026-03-08","America/New_York")).toBe(23*3600000);
  });
  it("allows an empty current day at exactly local midnight", async () => {
    const s=await store(); const r=usageReport(s.db,{period:"today",timezone:"Asia/Seoul",asOf:dayStart},dayStart);
    expect(r.scope.from).toBe(dayStart); expect(r.scope.to).toBe(dayStart); expect(r.total.total).toBe("0");
    expect(r.previous.from).toBe(dayStart-86400000); expect(r.previous.to).toBe(dayStart-86400000);
  });
  it("rejects invalid date/timezone/asOf/filter/ranges using safe domain codes", () => {
    expect(() => resolveReportScope({period:"custom",from:"2026-99-99",to:"2026-99-99"},noon)).toThrow("invalid_date");
    expect(() => resolveReportScope({timezone:"Not/A_Zone"},noon)).toThrow("invalid_timezone");
    expect(() => resolveReportScope({asOf:noon+1},noon)).toThrow("invalid_as_of");
    expect(() => resolveReportScope({model:""},noon)).toThrow("invalid_filter");
    expect(() => resolveReportScope({period:"custom",from:"2024-01-01",to:"2026-01-01"},noon)).toThrow("invalid_range");
  });
});
describe("exact report reconciliation", () => {
  it("keeps begin inclusive, end excluded and asOf later snapshots out", async () => {
    const s=await store(); usage(s,"begin",{first_event_at:dayStart,snapshot_at:dayStart}); usage(s,"before",{first_event_at:dayStart-1,snapshot_at:dayStart-1});
    usage(s,"end",{first_event_at:noon,snapshot_at:noon}); usage(s,"futureSnapshot",{snapshot_at:noon+1});
    const r=query(s); expect(r.total.total).toBe("1150"); expect(r.requests.items.map(x=>x.id)).toEqual(["begin"]);
  });
  it("keeps snapshot updates after midnight attributed to the first event day", async () => {
    const s=await store(); usage(s,"late",{first_event_at:dayStart-1,snapshot_at:dayStart+1});
    expect(query(s).total.requests).toBe(0);
    const r=query(s,{period:"7"}); expect(r.days.find(d=>d.date==="2026-09-24")!.total).toBe("1150"); expect(r.days.find(d=>d.date==="2026-09-25")!.total).toBe("0");
  });
  it("matches hand-calculated $0.001435 with synthetic rates and $0.0021525 official rates", async () => {
    const s=await store(); PRICING.rates["fixture-model"]=[2000,10000,200,2500,4000]; usage(s,"synthetic",{model:"fixture-model"}); usage(s,"known");
    expect(query(s,{model:"fixture-model"}).total).toMatchObject({total:"1150",costUsd:"0.001435000",coverage:1});
    expect(query(s,{model:"claude-sonnet-4-6"}).total.costUsd).toBe("0.002152500");
  });
  it("sums beyond safe JS and SQLite aggregate integer ranges without precision loss", async () => {
    const s=await store(); const n=9_000_000_000_000_000_000n;
    usage(s,"huge1",{input_tokens:n,output_tokens:0n,cache_read_tokens:0n,cache_write_tokens:0n,cache_write_5m:0n,cache_write_1h:0n});
    usage(s,"huge2",{input_tokens:n,output_tokens:0n,cache_read_tokens:0n,cache_write_tokens:0n,cache_write_5m:0n,cache_write_1h:0n});
    const r=query(s); expect(r.total.total).toBe("18000000000000000000"); expect(r.total.costUsd).toBe("54000000000000.000000000");
  });
  it("separates known zero, unknown model, invalid TTL and conflicts", async () => {
    const s=await store(); usage(s,"zero",{input_tokens:0n,output_tokens:0n,cache_read_tokens:0n,cache_write_tokens:0n,cache_write_5m:0n,cache_write_1h:0n});
    expect(query(s).total).toMatchObject({total:"0",requests:1,costUsd:"0.000000000",coverage:1});
    usage(s,"unknown",{model:"future-model"}); usage(s,"badttl",{cost_eligibility:"invalid_cache_split"}); usage(s,"conflict",{validity:"conflict"});
    const r=query(s); expect(r.total).toMatchObject({total:"2300",requests:3,pricedRequests:1,costUsd:"0.000000000",coverage:1/3,unpriced:{unknown_model:1,invalid_cache_split:1}});
    expect(r.quality.conflicts).toBe(1); expect(query(s,{model:"future-model"}).total.costUsd).toBeNull();
  });
  it("reconciles project+unassigned, model, day, token components and exact filters", async () => {
    const s=await store(); usage(s,"a"); usage(s,"b",{workspace_id:"wu",model:"claude-haiku-4-5-20251001",input_tokens:20n,output_tokens:10n,cache_read_tokens:0n,cache_write_tokens:0n,cache_write_5m:0n,cache_write_1h:0n});
    const r=query(s); for(const parts of [r.projects,r.models,r.days]) expect(parts.reduce((n,p)=>n+BigInt(p.total),0n).toString()).toBe(r.total.total);
    expect(BigInt(r.total.input)+BigInt(r.total.output)+BigInt(r.total.cacheRead)+BigInt(r.total.cacheWrite)).toBe(1180n);
    expect(query(s,{projectId:"unassigned"}).total.total).toBe("30"); expect(query(s,{providerId:"other"}).total.total).toBe("0");
  });
  it("remaps past usage atomically without changing global total and increments revision", async () => {
    const s=await store(); usage(s,"a"); usage(s,"b",{workspace_id:"wu"});
    const before=query(s); updateProject(s.db,{workspaceId:"wu",projectId:"alpha"}); const after=query(s);
    expect(after.total).toEqual(before.total); expect(after.projects).toHaveLength(1); expect(after.mappingRevision).toBe("1");
    expect(()=>updateProject(s.db,{label:"Must roll back",workspaceId:"missing"})).toThrow(); expect(s.db.prepare("SELECT count(*) n FROM project").get()).toEqual({n:1n});
  });
  it("keeps one SQLite read snapshot while another connection remaps a workspace", async () => {
    const s=await store(); usage(s,"a");
    const writer=new Database(join(dirs[0]!,DEFAULTS.databaseFile));
    const prepare=s.db.prepare.bind(s.db); let mutated=false;
    const spy=vi.spyOn(s.db,"prepare").mockImplementation(((sql:string)=>{
      if(!mutated && sql.startsWith("SELECT u.*")) {
        mutated=true; writer.transaction(()=>{writer.prepare("UPDATE workspace SET project_id=NULL WHERE id='wa'").run();writer.prepare("UPDATE metadata SET mapping_revision=mapping_revision+1").run();})();
      }
      return prepare(sql);
    }) as typeof s.db.prepare);
    try {const report=query(s); expect(report.mappingRevision).toBe("0"); expect(report.projects.map(p=>p.id)).toEqual(["alpha"]);}
    finally {spy.mockRestore();writer.close();}
    const next=query(s); expect(next.mappingRevision).toBe("1"); expect(next.projects.map(p=>p.id)).toEqual(["unassigned"]);
  });
  it("compares previous period at the same local elapsed time", async () => {
    const s=await store(); usage(s,"now"); usage(s,"coverage-before-previous",{first_event_at:dayStart-48*3600000,snapshot_at:dayStart-48*3600000}); usage(s,"yesterday-am",{first_event_at:dayStart-23*3600000,snapshot_at:dayStart-23*3600000});
    usage(s,"yesterday-pm",{first_event_at:dayStart-1,snapshot_at:dayStart-1});
    const r=query(s); expect(r.previous.to).toBe(noon-86400000); expect(r.previous.total).toBe("1150"); expect(r.previous.changePercent).toBe(0);
  });
  it("does not report a percentage when prior data starts partway through the comparison period", async () => {
    const s=await store(); usage(s,"now"); usage(s,"previous-partial",{first_event_at:dayStart-23*3600000,snapshot_at:dayStart-23*3600000});
    expect(query(s).previous.changePercent).toBeNull();
  });
  it("omits comparison percentages for no prior baseline or incomplete collection", async () => {
    const s=await store(); usage(s,"now"); expect(query(s).previous.changePercent).toBeNull();
    usage(s,"previous",{first_event_at:dayStart-23*3600000,snapshot_at:dayStart-23*3600000}); s.db.exec("UPDATE collector_scan SET state='backfilling'"); expect(query(s).previous.changePercent).toBeNull();
  });
  it("exports same project totals and scope with formula-safe labels", async () => {
    const s=await store(); usage(s,"a"); s.db.prepare("UPDATE project SET label=? WHERE id='alpha'").run('=SUM(1,2)');
    const r=query(s); const csv=reportCsv(r); expect(csv).toContain('"\'=SUM(1,2)"'); expect(csv).toContain('"1150"'); expect(csv).toContain(r.pricing.version); expect(csv).toContain(r.mappingRevision);
    s.db.prepare("UPDATE project SET label=? WHERE id='alpha'").run('\n=SUM(1,2)'); expect(reportCsv(query(s))).toContain('"\'\n=SUM(1,2)"');
  });
});
