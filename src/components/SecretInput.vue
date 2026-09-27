<script setup lang="ts">
import { computed, ref } from 'vue';
import { SECRET_MASK } from '../../shared/types';

// Secrets are never sent to the browser. A saved secret arrives as SECRET_MASK;
// typing replaces it, clearing the box keeps it, and "Remove" deletes it.
const model = defineModel<string>({ required: true });
defineProps<{ placeholder?: string; id?: string; inputmode?: 'numeric' | 'text' }>();
const original = ref(model.value);
const show = ref(false);
const saved = computed(() => model.value === SECRET_MASK);

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  model.value = v || (original.value === SECRET_MASK ? SECRET_MASK : '');
}
function remove() {
  original.value = '';
  model.value = '';
}
</script>

<template>
  <div class="flex gap-2">
    <input
      :id="id"
      :type="show ? 'text' : 'password'"
      class="field font-mono"
      :value="saved ? '' : model"
      :placeholder="saved ? '•••••••• saved — type to replace' : (placeholder ?? '')"
      :inputmode="inputmode"
      autocomplete="new-password"
      spellcheck="false"
      @input="onInput"
    />
    <button v-if="!saved && model" type="button" class="btn-quiet !px-3 text-sm" @click="show = !show">
      {{ show ? 'Hide' : 'Show' }}
    </button>
    <button v-if="saved" type="button" class="btn-quiet !px-3 text-sm text-rose-600" @click="remove">
      Remove
    </button>
  </div>
</template>
