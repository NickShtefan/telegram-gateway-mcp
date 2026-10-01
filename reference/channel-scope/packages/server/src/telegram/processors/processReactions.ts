import type { Reaction } from 'channel-scope-shared';
import type { GramJSReactionResult } from '../../types/index.js';

/**
 * Convert GramJS reaction results to our Reaction[] format.
 * Shared between refreshService and researchService.
 */
export function processReactionsFromGramJS(
  messageReactions: { results?: GramJSReactionResult[] } | undefined | null,
): Reaction[] {
  if (!messageReactions || !Array.isArray(messageReactions.results) || messageReactions.results.length === 0) {
    return [];
  }
  const reactionsArray: Reaction[] = [];
  for (const result of messageReactions.results) {
    if (result && result.reaction && typeof result.count === 'number') {
      const reactionKey = result.reaction.emoticon
        ? result.reaction.emoticon.toString()
        : result.reaction.className === 'ReactionPaid'
          ? '⭐'
          : JSON.stringify(result.reaction);
      reactionsArray.push({ reaction: reactionKey, count: result.count });
    }
  }
  return reactionsArray;
}
