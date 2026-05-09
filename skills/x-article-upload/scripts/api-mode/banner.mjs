// Page-side progress banner shown at the very top of the X article
// editor while the api-mode publish is running. Lets the user know
// they shouldn't type into the editor and gives a phase-by-phase
// status readout.

const BANNER_ID = "__x_article_uploader_banner__";

function buildBannerJs(text, color) {
	// Single self-contained IIFE so each call is idempotent (creates the
	// element if missing, updates style+text if present).
	return `(()=>{
    let el=document.getElementById(${JSON.stringify(BANNER_ID)});
    if(!el){
      el=document.createElement('div');
      el.id=${JSON.stringify(BANNER_ID)};
      document.body.appendChild(el);
    }
    el.style.cssText=[
      'position:fixed','top:0','left:0','right:0','z-index:2147483647',
      'background:'+${JSON.stringify(color)},
      'color:#fff','font-size:15px','font-weight:600',
      'padding:12px 20px','text-align:center',
      'box-shadow:0 2px 12px rgba(0,0,0,0.25)',
      'font-family:-apple-system,Segoe UI,system-ui,sans-serif',
      'letter-spacing:0.3px',
      'transition:background 0.25s ease',
      'pointer-events:none'
    ].join(';');
    el.textContent=${JSON.stringify(text)};
    return 'banner-set';
  })()`;
}

const COLORS = {
	warn: "linear-gradient(90deg,#f59e0b,#ef4444)", // orange→red, "don't touch"
	work: "linear-gradient(90deg,#1d9bf0,#7c3aed)", // blue→purple, "in progress"
	done: "linear-gradient(90deg,#10b981,#1d9bf0)", // green→blue, "success"
};

export async function setBanner(bridge, text, kind = "work") {
	const color = COLORS[kind] || COLORS.work;
	try {
		await bridge.evalJS(buildBannerJs(text, color));
	} catch {
		// banner is cosmetic — don't let a failed display abort the publish
	}
}

export async function clearBanner(bridge) {
	try {
		await bridge.evalJS(
			`(()=>{document.getElementById(${JSON.stringify(BANNER_ID)})?.remove();return 'banner-cleared'})()`,
		);
	} catch {
		/* ignore */
	}
}
