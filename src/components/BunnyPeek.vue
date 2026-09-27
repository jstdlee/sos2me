<script setup lang="ts">
// Original SOS2me bunny peeking over an edge: ears, top of the head, eyes and two little paws.
// Place it *behind* a card/button (lower z-index) so the button hides the rest of the head.
withDefaults(defineProps<{ tone?: 'white' | 'grey' }>(), { tone: 'white' });
</script>

<template>
  <svg viewBox="0 0 120 96" aria-hidden="true" class="pointer-events-none select-none">
    <g
      stroke="var(--color-outline)"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="#fff"
    >
      <!-- ears -->
      <path d="M38 50 C 30 22 34 4 44 4 C 54 4 56 26 54 50 Z" />
      <path d="M66 50 C 66 26 72 6 82 8 C 92 10 88 32 80 52 Z" />
      <!-- head (bottom half is hidden behind the button) -->
      <path
        d="M14 96 C 12 56 34 38 60 38 C 86 38 108 56 106 96 Z"
        :fill="tone === 'grey' ? '#fff' : '#fff'"
      />
      <path
        v-if="tone === 'grey'"
        d="M72 40 C 92 44 106 62 106 90 C 92 80 80 60 72 40 Z"
        fill="#dcd6d3"
        stroke="none"
      />
    </g>
    <!-- inner ears -->
    <path
      d="M44 12 C 43 24 44 36 46 46"
      stroke="var(--color-blush-200)"
      stroke-width="5"
      stroke-linecap="round"
      fill="none"
    />
    <path
      d="M80 15 C 78 26 76 36 73 46"
      stroke="var(--color-blush-200)"
      stroke-width="5"
      stroke-linecap="round"
      fill="none"
    />
    <!-- face -->
    <g fill="#4f4744">
      <circle cx="46" cy="70" r="3.6" />
      <circle cx="74" cy="70" r="3.6" />
    </g>
    <path
      d="M55 78 q2.5 3 5 0 q2.5 3 5 0"
      stroke="#4f4744"
      stroke-width="2.4"
      stroke-linecap="round"
      fill="none"
    />
    <g fill="var(--color-blush-200)">
      <ellipse cx="34" cy="80" rx="6.5" ry="4" />
      <ellipse cx="86" cy="80" rx="6.5" ry="4" />
    </g>
    <!-- paws resting on the edge -->
    <g stroke="var(--color-outline)" stroke-width="3" fill="#fff">
      <ellipse cx="36" cy="94" rx="9" ry="6" />
      <ellipse cx="84" cy="94" rx="9" ry="6" />
    </g>
  </svg>
</template>
