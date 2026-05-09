// POST X's article GraphQL endpoints from inside the page (so cookies + csrf
// auto-attach). Runs through bridge.evalJS — works under Playwright MCP and
// bb-browser identically.

const FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

// queryId hashes are X-internal GraphQL IDs and may rotate on X releases.
// If saves start 404'ing, re-scrape from the page's network tab and update here.
const QUERY_IDS = {
  UPDATE_CONTENT: "M7N2FrPrlOmu-YrVIBxFnQ",
  UPDATE_TITLE: "x75E2ABzm8_mGTg1bz8hcA",
  GET_BY_ID: "8-OHhj8-KCAHUP8XjPaAYQ",
};

function authHeadersJs() {
  return `(()=>{
    const csrf=(document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/)||[])[1];
    return {Authorization:'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA','x-csrf-token':csrf,'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes'};
  })()`;
}

export async function saveContent({ bridge, articleId, contentState }) {
  const body = {
    variables: { content_state: contentState, article_entity: articleId },
    features: FEATURES,
    queryId: QUERY_IDS.UPDATE_CONTENT,
  };
  const js = `(async()=>{
    const H=${authHeadersJs()};
    const r=await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_CONTENT}/ArticleEntityUpdateContent',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();
    let j=null;try{j=JSON.parse(t)}catch{}
    return JSON.stringify({status:r.status,err:j?.errors?.[0]?.message||null,hasData:!!j?.data?.articleentity_update_content_state,raw:t.slice(0,500)});
  })()`;
  return bridge.evalJS(js);
}

export async function saveTitle({ bridge, articleId, title }) {
  if (!title) return { skipped: true };
  const body = {
    variables: { articleEntityId: articleId, title },
    features: FEATURES,
    queryId: QUERY_IDS.UPDATE_TITLE,
  };
  const js = `(async()=>{
    const H=${authHeadersJs()};
    const r=await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_TITLE}/ArticleEntityUpdateTitle',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    return JSON.stringify({status:r.status,err:j?.errors?.[0]?.message||null,raw:t.slice(0,300)});
  })()`;
  return bridge.evalJS(js);
}

export async function getArticleState({ bridge, articleId }) {
  const v = JSON.stringify({ articleEntityId: articleId });
  const f = JSON.stringify(FEATURES);
  const ft = JSON.stringify({ withArticleRichContentState: true });
  const js = `(async()=>{
    const H=${authHeadersJs()};
    const u='https://x.com/i/api/graphql/${QUERY_IDS.GET_BY_ID}/ArticleEntityResultByRestId?variables='+encodeURIComponent(${JSON.stringify(v)})+'&features='+encodeURIComponent(${JSON.stringify(f)})+'&fieldToggles='+encodeURIComponent(${JSON.stringify(ft)});
    const r=await fetch(u,{credentials:'include',headers:{...H}});
    const j=await r.json();
    const cs=j?.data?.article_result_by_rest_id?.result?.content_state;
    return JSON.stringify({title:j?.data?.article_result_by_rest_id?.result?.title||null,blockCount:cs?.blocks?.length||0,entityCount:cs?.entityMap?.length||0});
  })()`;
  return bridge.evalJS(js);
}
