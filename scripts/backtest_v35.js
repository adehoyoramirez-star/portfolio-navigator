// backtest_v35.js - OLYMPUS HMR v3.5 STRICT vs HYBRID on SPY+QQQ 6 months
var fs = require('fs');
var PRESET = { rsi_bot:20, rsi_top:80, channel_bot:0.25, channel_top:0.75, reg_len:120, band_mult:2.0, adx_thresh:15, adx_cap:60, atr_sl_mult:1.5, tp1_rr:1.0, trail_atr:2.0, ema_fast:50, ema_slow:200 };
var P = { rsi2_len:2, adx_len:14, swing_len:6, vol_len:20, strict_min:70, hybrid_min:50, hybrid_gates:4, lz_k:12, lz_lb:60, lz_min:4 };
function sma(a,p,i){ var s=0; for(var j=i-p+1;j<=i;j++) s+=a[j]; return s/p; }
function ema(a,p,i){ var k=2/(p+1),e=a[0]; for(var j=1;j<=i;j++) e=a[j]*k+e*(1-k); return e; }
function sd(a,p,i){ var m=sma(a,p,i),s=0; for(var j=i-p+1;j<=i;j++) s+=(a[j]-m)*(a[j]-m); return Math.sqrt(s/p); }
function lr(a,p,i){ var sx=0,sy=0,xy=0,x2=0; for(var j=0;j<p;j++){ var x=j+1,y=a[i-p+1+j]; sx+=x;sy+=y;xy+=x*y;x2+=x*x;} var sl=(p*xy-sx*sy)/(p*x2-sx*sx); return sl*p+(sy-sl*sx)/p; }
function rsi(a,p,i){ var g=0,l=0; for(var j=i-p+1;j<=i;j++){ var d=a[j]-a[j-1]; if(d>0) g+=d; else l-=d;} if(l===0) return 100; return 100-100/(1+g/l); }
function atrVal(h,l,c,i,p){ if(p===undefined) p=14; var s=0; for(var j=i-p+1;j<=i;j++) s+=Math.max(h[j]-l[j], Math.abs(h[j]-c[j-1]), Math.abs(l[j]-c[j-1])); return s/p; }
function adx(c,h,l,i,p){ if(p===undefined) p=14; if(i<p*2) return 0; var tr=[],pdm=[],mdm=[]; for(var j=1;j<=i;j++){ tr.push(Math.max(h[j]-l[j], Math.abs(h[j]-c[j-1]), Math.abs(l[j]-c[j-1]))); var u=h[j]-h[j-1], d=l[j-1]-l[j]; pdm.push((u>d&&u>0)?u:0); mdm.push((d>u&&d>0)?d:0);} var sTR=0,sP=0,sM=0; for(var j=0;j<p;j++){sTR+=tr[j];sP+=pdm[j];sM+=mdm[j];} for(var j=p;j<tr.length;j++){sTR=sTR-sTR/p+tr[j];sP=sP-sP/p+pdm[j];sM=sM-sM/p+mdm[j];} if(sTR<0.0001) return 0; var pDI=100*sP/sTR, mDI=100*sM/sTR; return (pDI+mDI)>0 ? 100*Math.abs(pDI-mDI)/(pDI+mDI) : 0; }
function pH(h,i){ if(i<P.swing_len*2) return false; var v=h[i-P.swing_len]; for(var j=i-P.swing_len*2;j<i-P.swing_len;j++) if(h[j]>=v) return false; for(var j=i-P.swing_len+1;j<=i;j++) if(h[j]>=v) return false; return true; }
function pL(l,i){ if(i<P.swing_len*2) return false; var v=l[i-P.swing_len]; for(var j=i-P.swing_len*2;j<i-P.swing_len;j++) if(l[j]<=v) return false; for(var j=i-P.swing_len+1;j<=i;j++) if(l[j]<=v) return false; return true; }

function lzFeat(c,h,l,i){
  var hlc3 = c.map(function(_,k){ return (h[k]+l[k]+c[k])/3; });
  var f1 = rsi(c,14,i);
  var f2 = 0;
  if(i>=21){
    var e21 = ema(hlc3,21,i), s21 = sma(hlc3,21,i);
    var dev=0; for(var j=i-20;j<=i;j++) dev += Math.abs(c[j] - sma(hlc3,21,j));
    f2 = (e21-s21)/Math.max(0.0001, 0.015*(dev/21));
  }
  var f3 = 0;
  if(i>=20){
    var sm=0; for(var j=i-19;j<=i;j++) sm += hlc3[j];
    var ma = sm/20;
    var md = 0; for(var j=i-19;j<=i;j++) md += Math.abs(hlc3[j]-ma);
    f3 = (hlc3[i]-ma)/Math.max(0.0001, 0.015*(md/20));
  }
  var a14 = atrVal(h,l,c,i);
  return { f1:f1, f2:f2, f3:f3, f4:adx(c,h,l,i), f5:(a14/Math.max(0.0001,c[i]))*100 };
}

function lzSig(v, mem){
  if(mem.length < 5) return 0;
  var ds = [];
  for(var j=0;j<mem.length;j++){
    var m = mem[j]; if(m.y===0) continue;
    var d = Math.log(1+Math.abs(v.f1-m.f1)) + Math.log(1+Math.abs(v.f2-m.f2)) + Math.log(1+Math.abs(v.f3-m.f3)) + Math.log(1+Math.abs(v.f4-m.f4)) + Math.log(1+Math.abs(v.f5-m.f5));
    ds.push({d:d, y:m.y});
  }
  ds.sort(function(a,b){ return a.d-b.d; });
  var k = Math.min(P.lz_k, ds.length);
  var s = 0;
  for(var j=0;j<k;j++) s += ds[j].y;
  if(s >= P.lz_min) return 1;
  if(s <= -P.lz_min) return -1;
  return 0;
}

async function loadBars(tk){
  var cp = tk + '_daily.csv';
  if(fs.existsSync(cp)){
    var raw = fs.readFileSync(cp,'utf-8').trim().split('\n');
    return raw.slice(1).map(function(line){
      var p = line.split(',');
      return { d:p[0], o:+p[1], h:+p[2], l:+p[3], c:+p[4], v:+p[5] };
    });
  }
  console.log('  Downloading ' + tk + ' via yahoo-finance2...');
  var yfMod = await import('yahoo-finance2');
  var yf = yfMod.default;
  var rows = await yf.historical(tk, { period1:new Date('2025-10-01'), period2:new Date('2026-06-17'), interval:'1d' });
  var bars = rows.map(function(r){
    return { d:new Date(r.date).toISOString().slice(0,10), o:(r.open||r.close), h:(r.high||r.close), l:(r.low||r.close), c:r.close, v:Number(r.volume)||0 };
  });
  var csv = 'Date,Open,High,Low,Close,Volume\n' + bars.map(function(b){ return b.d+','+b.o+','+b.h+','+b.l+','+b.c+','+b.v; }).join('\n');
  fs.writeFileSync(cp, csv);
  console.log('    saved ' + bars.length + ' rows to ' + cp);
  return bars;
}

function runBT(tk, bars, mode){
  var c = bars.map(function(b){ return b.c; });
  var h = bars.map(function(b){ return b.h; });
  var l = bars.map(function(b){ return b.l; });
  var v = bars.map(function(b){ return b.v; });
  var lzMem = []; var trades = []; var pos = null;
  var lSh=null, pSh=null, lSl=null, pSl=null;
  for(var i=200; i<bars.length; i++){
    if(i >= 204){
      var f = lzFeat(c,h,l,i-4);
      var y = (c[i]>c[i-4]) ? 1 : ((c[i]<c[i-4]) ? -1 : 0);
      lzMem.push({ f1:f.f1, f2:f.f2, f3:f.f3, f4:f.f4, f5:f.f5, y:y });
      if(lzMem.length > P.lz_lb) lzMem.shift();
    }
    if(pH(h,i)){ pSh=lSh; lSh=h[i-P.swing_len]; }
    if(pL(l,i)){ pSl=lSl; lSl=l[i-P.swing_len]; }
    var bS = (pSh!==null && lSh!==null && pSl!==null && lSl!==null && lSh>pSh && lSl>pSl);
    var brS = (pSh!==null && lSh!==null && pSl!==null && lSl!==null && lSh<pSh && lSl<pSl);
    var L = lr(c, PRESET.reg_len, i);
    var stdV = sd(c, PRESET.reg_len, i);
    var upper = L + PRESET.band_mult*stdV;
    var lower = L - PRESET.band_mult*stdV;
    var chPos = (c[i]-lower) / Math.max(0.0001, upper-lower);
    var r2 = rsi(c, P.rsi2_len, i);
    var av = adx(c,h,l,i);
    var eF = ema(c, PRESET.ema_fast, i);
    var eS = ema(c, PRESET.ema_slow, i);
    var bR = eF > eS;
    var brR = eF < eS;
    var a14 = atrVal(h,l,c,i);
    var vAvg = sma(v, P.vol_len, i);
    var vSpike = v[i] > vAvg*1.5;
    var wB = l[i]<lower && c[i]>lower;
    var wBe = h[i]>upper && c[i]<upper;
    var sc = 0;
    if(r2<PRESET.rsi_bot && bR) sc+=16;
    else if(r2>PRESET.rsi_top && brR) sc+=16;
    if(av>PRESET.adx_thresh && av<PRESET.adx_cap) sc+=12;
    if(bR) sc+=10;
    sc+=12;
    if(bS && bR) sc+=10;
    else if(brS && brR) sc+=10;
    if(chPos<PRESET.channel_bot && bR) sc+=16;
    else if(chPos>PRESET.channel_top && brR) sc+=16;
    if((vSpike && c[i]>bars[i].o && chPos<0.5) && bR) sc+=8;
    else if((vSpike && c[i]<bars[i].o && chPos>0.5) && brR) sc+=8;
    sc+=6;
    var gL = (wB?1:0)+(chPos<PRESET.channel_bot?1:0)+(r2<PRESET.rsi_bot?1:0)+((av>PRESET.adx_thresh&&av<PRESET.adx_cap)?1:0)+(bR?1:0)+(bR?1:0)+(bS?1:0)+(vSpike?1:0);
    var gS = (wBe?1:0)+(chPos>PRESET.channel_top?1:0)+(r2>PRESET.rsi_top?1:0)+((av>PRESET.adx_thresh&&av<PRESET.adx_cap)?1:0)+(brR?1:0)+(brR?1:0)+(brS?1:0)+(vSpike?1:0);
    var sigL = (gL===8) && (sc>=P.strict_min);
    var sigS = (gS===8) && (sc>=P.strict_min);
    if(mode==='HYBRID' && i>=204){
      var vz = lzFeat(c,h,l,i);
      var lz = lzSig(vz, lzMem);
      sigL = sigL || (lz===1 && gL>=P.hybrid_gates && sc>=P.hybrid_min);
      sigS = sigS || (lz===-1 && gS>=P.hybrid_gates && sc>=P.hybrid_min);
    }
    if(pos !== null){
      if(pos.tr !== null){
        if(pos.side==='LONG') pos.tr = Math.max(pos.tr, h[i]-a14*PRESET.trail_atr);
        else pos.tr = Math.min(pos.tr, l[i]+a14*PRESET.trail_atr);
      }
      var ex = null;
      var rk = pos.ea * PRESET.atr_sl_mult;
      if(pos.side==='LONG'){
        if(l[i] <= pos.ep - rk) ex = {r:'STOP', px:pos.ep-rk};
        else if(pos.tr !== null && l[i] < pos.tr) ex = {r:'TRAIL', px:pos.tr};
        else if(i - pos.ei > 60) ex = {r:'TIMEOUT', px:c[i]};
      } else {
        if(h[i] >= pos.ep + rk) ex = {r:'STOP', px:pos.ep+rk};
        else if(pos.tr !== null && h[i] > pos.tr) ex = {r:'TRAIL', px:pos.tr};
        else if(i - pos.ei > 60) ex = {r:'TIMEOUT', px:c[i]};
      }
      if(ex){
        var rr = pos.side==='LONG' ? (ex.px-pos.ep)/rk : (pos.ep-ex.px)/rk;
        trades.push({ e:bars[pos.ei].d, x:bars[i].d, side:pos.side, r:rr, mode:mode });
        pos = null;
      }
    
