// 通过 bb-browser eval 在 X 页面调 ArticleEntityUpdateContent / UpdateTitle / Result 接口
import { evalJS } from "./bb.mjs";

const FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const QUERY_IDS = {
  UPDATE_CONTENT: "M7N2FrPrlOmu-YrVIBxFnQ",
  UPDATE_TITLE: "x75E2ABzm8_mGTg1bz8hcA",
  GET_BY_ID: "8-OHhj8-KCAHUP8XjPaAYQ",
};

function buildAuthHeadersJs() {
  return `(()=>{
    const csrf=(document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/)||[])[1];
    return {Authorization:'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA','x-csrf-token':csrf,'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes'};
  })()`;
}

export async function saveContent({ articleId, contentState, tab }) {
  const body = {
    variables: { content_state: contentState, article_entity: articleId },
    features: FEATURES,
    queryId: QUERY_IDS.UPDATE_CONTENT,
  };
  const js = `(async()=>{
    const H=${buildAuthHeadersJs()};
    const r=await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_CONTENT}/ArticleEntityUpdateContent',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();
    let j=null;try{j=JSON.parse(t)}catch{}
    return JSON.stringify({status:r.status,err:j?.errors?.[0]?.message||null,hasData:!!j?.data?.articleentity_update_content_state,raw:t.slice(0,500)});
  })()`;
  return evalJS(js, { tab, timeoutMs: 30000 });
}

export async function saveTitle({ articleId, title, tab }) {
  if (!title) return { skipped: true };
  const body = {
    variables: { articleEntityId: articleId, title },
    features: FEATURES,
    queryId: QUERY_IDS.UPDATE_TITLE,
  };
  const js = `(async()=>{
    const H=${buildAuthHeadersJs()};
    const r=await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_TITLE}/ArticleEntityUpdateTitle',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    return JSON.stringify({status:r.status,err:j?.errors?.[0]?.message||null,raw:t.slice(0,300)});
  })()`;
  return evalJS(js, { tab, timeoutMs: 15000 });
}

export async function getArticleState({ articleId, tab }) {
  const v = JSON.stringify({ articleEntityId: articleId });
  const f = JSON.stringify(FEATURES);
  const ft = JSON.stringify({ withArticleRichContentState: true });
  const js = `(async()=>{
    const H=${buildAuthHeadersJs()};
    const u='https://x.com/i/api/graphql/${QUERY_IDS.GET_BY_ID}/ArticleEntityResultByRestId?variables='+encodeURIComponent(${JSON.stringify(v)})+'&features='+encodeURIComponent(${JSON.stringify(f)})+'&fieldToggles='+encodeURIComponent(${JSON.stringify(ft)});
    const r=await fetch(u,{credentials:'include',headers:{...H}});
    const j=await r.json();
    const cs=j?.data?.article_result_by_rest_id?.result?.content_state;
    return JSON.stringify({title:j?.data?.article_result_by_rest_id?.result?.title||null,blockCount:cs?.blocks?.length||0,entityCount:cs?.entityMap?.length||0,first:cs?.blocks?.slice(0,3)});
  })()`;
  return evalJS(js, { tab, timeoutMs: 15000 });
}
