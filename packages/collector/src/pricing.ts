/** USD nano-units per token; standard global API equivalents, never subscription bills. */
export const PRICING: {version:string;source:string;retrievedAt:number;rates:Record<string,readonly number[]>}={
  version:'anthropic-standard-2026-09-25',source:'https://platform.claude.com/docs/en/about-claude/pricing',retrievedAt:Date.parse('2026-09-25T00:00:00Z'),
  rates:{
    'claude-sonnet-4-20250514':[3000,15000,300,3750,6000],
    'claude-sonnet-4-5-20250929':[3000,15000,300,3750,6000],
    'claude-haiku-4-5-20251001':[1000,5000,100,1250,2000],
    'claude-opus-4-5-20251101':[5000,25000,500,6250,10000],
    'claude-sonnet-4-6':[3000,15000,300,3750,6000],
    'claude-opus-4-6':[5000,25000,500,6250,10000],
    'claude-opus-4-7':[5000,25000,500,6250,10000],
    'claude-opus-4-8':[5000,25000,500,6250,10000],
    'claude-opus-5':[5000,25000,500,6250,10000],
    'claude-opus-5-5':[4000,20000,200,5000,8000],
    'claude-sonnet-5':[2000,10000,200,2500,4000],
    'claude-fable-5-1':[10000,50000,250,12500,20000]
  }
};
