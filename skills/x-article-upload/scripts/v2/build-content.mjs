// 把 segments[] + image media info 拼成 X 的 RawDraftContentState（snake_case）
//
// 输出：
//   { content_state: { blocks: [...], entity_map: [...] } }
//
// segments 里的 image 段需要在 mediaMap 里找到对应的 {mediaId,entityKey,localMediaId}
// （上一步 uploadOneImage 返回的）

const TWITTER_USER_AGENT_NA = "DraftTweetImage";

function genKey() {
  return Math.random().toString(36).slice(2, 7);
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function buildContentState(parsed, mediaMap) {
  // mediaMap: { [imageSourcePath]: {mediaId, entityKey, localMediaId, mediaCategory} }
  const blocks = [];
  const entityMap = [];

  // 我们用一个数组累计 entity，最终返回 [{key:'0',value:...}, ...]
  function pushEntity(value) {
    const idx = entityMap.length;
    entityMap.push({ key: String(idx), value });
    return idx;
  }

  for (const seg of parsed.segments) {
    if (seg.type === "text") {
      const block = {
        key: genKey(),
        type: seg.kind,
        text: seg.text,
        data: {},
        entity_ranges: [],
        inline_style_ranges: (seg.inlineStyleRanges || []).map((r) => ({
          offset: r.offset,
          length: r.length,
          style: r.style,
        })),
      };
      // Links → LINK entities
      for (const link of seg.links || []) {
        const entIdx = pushEntity({
          data: { url: link.url },
          type: "LINK",
          mutability: "Mutable",
        });
        block.entity_ranges.push({ key: entIdx, offset: link.offset, length: link.length });
      }
      blocks.push(block);
    } else if (seg.type === "divider") {
      const entIdx = pushEntity({ data: {}, type: "DIVIDER", mutability: "Immutable" });
      blocks.push(atomicBlock(entIdx));
    } else if (seg.type === "code") {
      const md = "```" + (seg.language || "") + "\n" + (seg.code || "") + "\n```";
      const entIdx = pushEntity({
        data: { markdown: md },
        type: "MARKDOWN",
        mutability: "Mutable",
      });
      blocks.push(atomicBlock(entIdx));
    } else if (seg.type === "tweet") {
      const entIdx = pushEntity({
        data: { tweet_id: seg.tweetId },
        type: "TWEET",
        mutability: "Immutable",
      });
      blocks.push(atomicBlock(entIdx));
    } else if (seg.type === "image") {
      const info = mediaMap[seg.source];
      if (!info) {
        // skip with warning
        console.warn(`[build-content] no mediaInfo for ${seg.source}; skipping image`);
        continue;
      }
      const entIdx = pushEntity({
        data: {
          entity_key: info.entityKey, // 必须复用 X 自己生成的，不能造新的
          media_items: [
            {
              local_media_id: String(info.localMediaId), // 必须字符串
              media_category: info.mediaCategory || TWITTER_USER_AGENT_NA,
              media_id: info.mediaId,
            },
          ],
        },
        type: "MEDIA",
        mutability: "Immutable",
      });
      blocks.push(atomicBlock(entIdx));
    }
  }

  // X 期望最后一个 block 是 unstyled (空) — 给 atomic 留个尾巴
  if (blocks.length === 0 || blocks[blocks.length - 1].type === "atomic") {
    blocks.push({
      key: genKey(),
      type: "unstyled",
      text: "",
      data: {},
      entity_ranges: [],
      inline_style_ranges: [],
    });
  }

  return { content_state: { blocks, entity_map: entityMap } };
}

function atomicBlock(entIdx) {
  return {
    key: genKey(),
    type: "atomic",
    text: " ",
    data: {},
    entity_ranges: [{ key: entIdx, offset: 0, length: 1 }],
    inline_style_ranges: [],
  };
}
