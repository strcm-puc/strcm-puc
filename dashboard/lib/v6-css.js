export const CSS = `
*{margin:0;padding:0;box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:pan-x pan-y;}
body{background:#ECEAE6;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;touch-action:pan-x pan-y;overscroll-behavior:none;}
.page{max-width:1100px;margin:0 auto;padding:36px 28px;display:flex;gap:44px;align-items:flex-start;flex-wrap:wrap;}
.left{flex-shrink:0;}
.right{flex:1;min-width:260px;padding-top:4px;}
.ptitle{font-size:10px;letter-spacing:3px;color:#999;text-transform:uppercase;font-weight:600;margin-bottom:18px;}
.phone{width:310px;height:660px;border-radius:44px;border:10px solid #111;background:#0A0A0A;overflow:hidden;display:flex;flex-direction:column;}
.sbar{flex-shrink:0;padding:12px 18px 4px;display:flex;justify-content:space-between;align-items:center;background:#0A0A0A;}
.brandw{flex-shrink:0;padding:6px 0 2px;text-align:center;background:#0A0A0A;}
.inner{flex:1;overflow-y:auto;scrollbar-width:none;position:relative;touch-action:pan-y;overscroll-behavior:contain;}
.inner::-webkit-scrollbar{display:none;}
.bnav{flex-shrink:0;background:#0D0D0D;border-top:0.5px solid #1C1C1C;padding:10px 0 16px;display:grid;grid-template-columns:repeat(4,1fr);}
.ni{text-align:center;cursor:pointer;}
.ni-ico{display:block;font-size:17px;line-height:1.4;}
.ni-lbl{font-size:11px;margin-top:2px;}
.lbtn{background:rgba(201,168,76,0.12);border:0.5px solid rgba(201,168,76,0.35);color:#C9A84C;font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 9px;border-radius:20px;cursor:pointer;font-family:inherit;}
.card{margin:6px 12px 0;background:#141414;border-radius:13px;padding:11px 13px;}
.card-lg{margin:10px 12px 0;background:#141414;border-radius:16px;padding:15px 14px;}
.btr{background:#1E1E1E;border-radius:3px;height:5px;overflow:hidden;}
.bfi{height:100%;border-radius:3px;width:0%;transition:width 1.5s cubic-bezier(0.4,0,0.2,1);}
.ebg{display:inline-block;background:rgba(201,168,76,0.12);border:0.5px solid rgba(201,168,76,0.25);color:#C9A84C;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;}
.ebb{display:inline-block;background:rgba(74,144,217,0.12);border:0.5px solid rgba(74,144,217,0.25);color:#4A90D9;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;}
.ptgt{margin:6px 12px 0;background:#0C1928;border-radius:13px;padding:12px 13px;border:0.5px solid rgba(74,144,217,0.18);}
.ls{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 12px 0;}
.lsc{background:#141414;border-radius:10px;padding:9px 8px;text-align:center;}
.lsv{font-size:14px;font-weight:600;}
.lsl{font-size:9px;color:#444;margin-top:2px;}
.le{padding:10px 12px;border-bottom:0.5px solid #111;display:flex;justify-content:space-between;align-items:flex-start;}
.le-l{flex:1;}
.le-d{color:#444;font-size:10px;margin-bottom:2px;}
.le-t{color:#C0C0C0;font-size:12px;line-height:1.5;}
.le-b{color:#282828;font-size:10px;margin-top:2px;}
.le-r{text-align:right;flex-shrink:0;margin-left:8px;}
.le-a{font-size:14px;font-weight:700;}
.bdg{font-size:9px;font-weight:700;letter-spacing:0.5px;padding:2px 5px;border-radius:3px;margin-top:3px;display:inline-block;}
.bc{color:#2ECC71;background:rgba(46,204,113,0.1);}
.br{color:#E74C3C;background:rgba(231,76,60,0.1);}
.bgr{color:#E67E22;background:rgba(230,126,34,0.1);}
.ftabs{display:flex;gap:6px;padding:10px 12px 4px;}
.ft{flex:1;text-align:center;font-size:10px;font-weight:600;padding:5px 0;border-radius:8px;cursor:pointer;border:0.5px solid #1E1E1E;color:#555;}
.ft.act{background:#C9A84C;color:#000;border-color:#C9A84C;}
.lbt{display:flex;gap:8px;padding:10px 12px 0;}
.lt{flex:1;text-align:center;font-size:11px;font-weight:600;padding:6px 0;border-radius:8px;cursor:pointer;border:0.5px solid #1E1E1E;color:#555;transition:all 0.2s;}
.lt.act{background:#C9A84C;color:#000;border-color:#C9A84C;}
.lt.actb{background:#4A90D9;color:#fff;border-color:#4A90D9;}
.lr{display:flex;align-items:center;padding:9px 12px;border-bottom:0.5px solid #111;}
.lr.r1{background:rgba(201,168,76,0.06);}
.lr.r2{background:rgba(180,180,180,0.03);}
.lr.r3{background:rgba(160,100,40,0.04);}
.lr.me{background:#150E00;border-left:2px solid #C9A84C;}
.lr.meb{background:#0A1622;border-left:2px solid #4A90D9;}
.lr.f50{opacity:0.3;}
.lrk{font-size:12px;font-weight:700;width:22px;flex-shrink:0;color:#555;}
.lnm{font-size:12px;flex:1;margin:0 8px;color:#888;}
.order-btn{margin:12px;background:#141414;border-radius:13px;padding:14px;display:flex;align-items:center;gap:12px;cursor:pointer;border:0.5px solid #2A2A2A;text-decoration:none;}
.order-btn:hover{background:#1A1A1A;}
.avatar{width:54px;height:54px;border-radius:50%;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#C9A84C;margin:0 auto 10px;}
.ic{margin:6px 12px 0;background:#141414;border-radius:13px;overflow:hidden;}
.ic-h{padding:10px 13px;display:flex;justify-content:space-between;align-items:center;}
.ic-b{padding:9px 13px;border-top:0.5px solid #1E1E1E;}
.ic-r{display:flex;justify-content:space-between;margin-bottom:7px;}
.ic-r:last-child{margin-bottom:0;}
.ref-card{margin:6px 12px 10px;background:#0A0A0A;border-radius:16px;padding:16px 14px;border:0.5px solid rgba(201,168,76,0.2);}
.ref-hero{text-align:center;margin-bottom:12px;}
.cfw{position:absolute;top:0;left:0;right:0;height:100%;pointer-events:none;overflow:hidden;z-index:5;}
@keyframes cffall{0%{top:-12px;opacity:1;transform:rotate(0deg);}100%{top:115%;opacity:0;transform:rotate(540deg);}}
.modal-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:10;display:none;}
.modal-box{background:#1A1A1A;border-radius:16px;padding:20px 18px;margin:0 16px;border:0.5px solid #2A2A2A;}
.screen{display:none;}
.screen.act{display:block;}
.ab{margin-bottom:22px;border-left:2px solid #C9A84C;padding-left:14px;}
.ak{font-size:10px;letter-spacing:2px;color:#C9A84C;text-transform:uppercase;font-weight:600;margin-bottom:4px;}
.av{font-size:13px;color:#666;line-height:1.75;}
`;
