// segments[] + media map → X RawDraftContentState (snake_case body).
// Identical to scripts/v2/build-content.mjs.

const TWITTER_USER_AGENT_NA = "DraftTweetImage";
const genKey = () => Math.random().toString(36).slice(2, 7);

export function buildContentState(parsed, mediaMap) {
  const blocks = [];
  const entityMap = [];
  const pushEntity = (value) => {
    const idx = entityMap.length;
    entityMap.push({ key: String(idx), value });
    return idx;
  };

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
        console.warn(`[build-content] no mediaInfo for ${seg.source}; skipping image`);
        continue;
      }
      const entIdx = pushEntity({
        data: {
          entity_key: info.entityKey,
          media_items: [
            {
              local_media_id: String(info.localMediaId),
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
