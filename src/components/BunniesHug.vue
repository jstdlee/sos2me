<script setup lang="ts">
// Two original round bunnies cuddling. Used as a calm illustration on the kid page and empty states.
</script>

<template>
  <svg viewBox="0 0 260 200" aria-hidden="true" class="pointer-events-none select-none">
    <!-- soft backdrop blob -->
    <ellipse cx="130" cy="112" rx="124" ry="84" fill="var(--color-blush-100)" />
    <g fill="#fff" opacity="0.9">
      <circle cx="30" cy="70" r="7" />
      <circle cx="228" cy="60" r="9" />
      <circle cx="214" cy="160" r="6" />
      <circle cx="44" cy="164" r="8" />
    </g>
    <g stroke="var(--color-outline)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
      <!-- grey bunny (right, behind) -->
      <path d="M150 50 C 146 20 158 8 166 14 C 174 20 170 40 166 58 Z" fill="#fff" />
      <path d="M176 56 C 182 26 196 18 202 26 C 208 34 196 50 186 64 Z" fill="#fff" />
      <path d="M120 176 C 108 120 130 56 172 56 C 214 56 228 120 214 176 Z" fill="#fff" />
      <path d="M172 58 C 206 60 222 110 218 150 C 196 140 178 100 172 58 Z" fill="#dcd6d3" stroke="none" />
      <circle cx="218" cy="160" r="10" fill="#fff" />
      <!-- white bunny (left, front) -->
      <path d="M70 58 C 58 26 68 10 78 14 C 88 18 88 42 86 62 Z" fill="#fff" />
      <path d="M98 60 C 100 30 114 20 122 28 C 128 36 118 52 108 66 Z" fill="#fff" />
      <path d="M40 180 C 26 122 52 60 96 60 C 140 60 158 122 146 180 Z" fill="#fff" />
      <!-- arm hugging -->
      <path d="M128 120 C 142 116 156 122 160 132 C 150 138 136 136 128 130" fill="#fff" />
      <!-- feet -->
      <ellipse cx="72" cy="182" rx="14" ry="8" fill="#fff" />
      <ellipse cx="118" cy="182" rx="14" ry="8" fill="#fff" />
    </g>
    <!-- inner ears -->
    <path
      d="M76 22 C 74 34 76 46 80 56"
      stroke="var(--color-blush-200)"
      stroke-width="5"
      stroke-linecap="round"
      fill="none"
    />
    <path
      d="M160 20 C 160 32 160 42 162 52"
      stroke="var(--color-blush-200)"
      stroke-width="5"
      stroke-linecap="round"
      fill="none"
    />
    <!-- faces -->
    <g fill="#4f4744">
      <circle cx="80" cy="104" r="3.6" />
      <circle cx="110" cy="104" r="3.6" />
      <circle cx="170" cy="96" r="3.4" />
      <circle cx="196" cy="96" r="3.4" />
    </g>
    <g stroke="#4f4744" stroke-width="2.6" stroke-linecap="round" fill="none">
      <path d="M89 113 q3.5 4 6.5 0 q3 4 6.5 0" />
      <path d="M177 104 q3 3.5 6 0 q3 3.5 6 0" />
    </g>
    <g fill="var(--color-blush-200)">
      <ellipse cx="70" cy="116" rx="7" ry="4.5" />
      <ellipse cx="121" cy="116" rx="7" ry="4.5" />
      <ellipse cx="162" cy="108" rx="6" ry="4" />
      <ellipse cx="205" cy="108" rx="6" ry="4" />
    </g>
  </svg>
</template>
