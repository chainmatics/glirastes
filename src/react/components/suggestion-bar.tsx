import { useState, useEffect, useCallback } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { SuggestionChip as DefaultSuggestionChip } from './suggestion-chip.js';
import type { SuggestionBarProps } from '../types.js';

const FADE_DURATION = 300;

/**
 * Suggestion bar with rotation/fade animation.
 *
 * Shows one suggestion at a time, rotating through the list
 * with a configurable interval and fade transition.
 * Pauses on hover.
 */
export function SuggestionBar({ className }: SuggestionBarProps) {
  const { suggestionChips, selectSuggestion, classNames, suggestions, components } = useChatContext();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const [isPaused, setIsPaused] = useState(false);

  const rotationInterval = suggestions.rotationInterval ?? 4000;

  const SuggestionChipComponent = components.SuggestionChip ?? DefaultSuggestionChip;

  // Reset index when chips change
  useEffect(() => {
    setCurrentIndex(0);
    setIsVisible(true);
  }, [suggestionChips]);

  // Rotation timer
  useEffect(() => {
    if (isPaused || suggestionChips.length <= 1) return;

    const interval = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % suggestionChips.length);
        setIsVisible(true);
      }, FADE_DURATION);
    }, rotationInterval);

    return () => clearInterval(interval);
  }, [isPaused, suggestionChips.length, rotationInterval]);

  const handleClick = useCallback(() => {
    selectSuggestion(suggestionChips[currentIndex]);
  }, [selectSuggestion, suggestionChips, currentIndex]);

  if (suggestionChips.length === 0) return null;

  return (
    <div
      className={className ?? classNames.suggestionChip}
      data-component="suggestion-bar"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <SuggestionChipComponent
        label={suggestionChips[currentIndex]}
        onClick={handleClick}
        isVisible={isVisible}
      />
    </div>
  );
}
