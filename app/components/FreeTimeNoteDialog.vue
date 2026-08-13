<script setup lang="ts">
import type { FreeTimeNote } from "~~/shared/schemas";

const props = defineProps<{
  open: boolean;
  timeLabel: string;
  durationLabel: string;
  note: FreeTimeNote | null;
  saving: boolean;
  errorMessage: string | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [content: string];
  delete: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const content = ref("");
const confirmingDelete = ref(false);

const normalizedContent = computed(() => content.value.trim());
const canSave = computed(
  () =>
    normalizedContent.value.length > 0 && normalizedContent.value.length <= 1000 && !props.saving
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      content.value = props.note?.content ?? "";
      confirmingDelete.value = false;
      nextTick(() => {
        if (!dialog.value?.open) dialog.value?.showModal();
      });
      return;
    }
    if (dialog.value?.open) dialog.value.close();
  },
  { immediate: true }
);

watch(
  () => props.note,
  (note) => {
    if (props.open) content.value = note?.content ?? "";
  }
);

function requestClose() {
  if (props.saving) return;
  emit("close");
}

function onDialogClick(event: MouseEvent) {
  if (event.target === dialog.value) requestClose();
}

function submit() {
  if (!canSave.value) return;
  emit("save", normalizedContent.value);
}
</script>

<template>
  <dialog
    ref="dialog"
    class="free-note-dialog"
    aria-labelledby="free-note-dialog-title"
    @cancel.prevent="requestClose"
    @click="onDialogClick"
  >
    <form class="free-note-dialog__panel" @submit.prevent="submit">
      <header class="free-note-dialog__header">
        <div>
          <h2 id="free-note-dialog-title" class="free-note-dialog__title">空き時間メモ</h2>
          <p class="free-note-dialog__time">{{ timeLabel }} · {{ durationLabel }}</p>
        </div>
        <button
          type="button"
          class="free-note-dialog__close"
          aria-label="閉じる"
          :disabled="saving"
          @click="requestClose"
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>

      <template v-if="confirmingDelete">
        <p class="free-note-dialog__confirm">このメモを削除しますか？</p>
        <p v-if="errorMessage" class="free-note-dialog__error" role="alert">
          {{ errorMessage }}
        </p>
        <div class="free-note-dialog__actions">
          <button
            type="button"
            class="free-note-dialog__button free-note-dialog__button--secondary"
            :disabled="saving"
            @click="confirmingDelete = false"
          >
            戻る
          </button>
          <button
            type="button"
            class="free-note-dialog__button free-note-dialog__button--danger"
            :disabled="saving"
            @click="$emit('delete')"
          >
            {{ saving ? "削除中…" : "削除する" }}
          </button>
        </div>
      </template>

      <template v-else>
        <label class="free-note-dialog__label" for="free-time-note-content">
          何をしていましたか？
        </label>
        <textarea
          id="free-time-note-content"
          v-model="content"
          class="free-note-dialog__textarea"
          maxlength="1000"
          rows="6"
          placeholder="例：昼食をとって、少し散歩"
          autofocus
          :disabled="saving"
        />
        <p class="free-note-dialog__count">{{ content.length }} / 1000</p>
        <p v-if="errorMessage" class="free-note-dialog__error" role="alert">
          {{ errorMessage }}
        </p>

        <div class="free-note-dialog__actions">
          <button
            v-if="note"
            type="button"
            class="free-note-dialog__button free-note-dialog__button--delete"
            :disabled="saving"
            @click="confirmingDelete = true"
          >
            削除
          </button>
          <button
            type="button"
            class="free-note-dialog__button free-note-dialog__button--secondary"
            :disabled="saving"
            @click="requestClose"
          >
            キャンセル
          </button>
          <button
            type="submit"
            class="free-note-dialog__button free-note-dialog__button--primary"
            :disabled="!canSave"
          >
            {{ saving ? "保存中…" : "保存" }}
          </button>
        </div>
      </template>
    </form>
  </dialog>
</template>

<style lang="scss" scoped>
$color-bg: #fafaf7;
$color-surface: #f2f0ea;
$color-border: #e2dfd6;
$color-text: #1a1814;
$color-text-muted: #6b6960;
$color-error: #c53030;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;

.free-note-dialog {
  padding: 0;
  width: min(480px, calc(100% - 32px));
  max-width: none;
  color: $color-text;
  background: transparent;
  border: none;

  &::backdrop {
    background: rgba(26, 24, 20, 0.48);
    backdrop-filter: blur(2px);
  }
}

.free-note-dialog__panel {
  padding: 24px;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 16px;
  box-shadow: 0 20px 50px rgba(26, 24, 20, 0.2);
}

.free-note-dialog__header {
  margin-bottom: 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.free-note-dialog__title {
  font-size: 18px;
  font-weight: 600;
}

.free-note-dialog__time {
  margin-top: 4px;
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;
}

.free-note-dialog__close {
  width: 36px;
  height: 36px;
  display: grid;
  flex-shrink: 0;
  color: $color-text-muted;
  background: $color-surface;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  place-items: center;

  &:disabled {
    opacity: 0.5;
    cursor: wait;
  }
}

.free-note-dialog__label {
  margin-bottom: 8px;
  display: block;
  font-size: 13px;
  font-weight: 600;
}

.free-note-dialog__textarea {
  padding: 12px 14px;
  width: 100%;
  min-height: 140px;
  display: block;
  resize: vertical;
  font: inherit;
  line-height: 1.6;
  color: $color-text;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 10px;

  &:focus-visible {
    border-color: $color-text;
    outline: 2px solid rgba(26, 24, 20, 0.15);
    outline-offset: 2px;
  }
}

.free-note-dialog__count {
  margin-top: 6px;
  font-family: $font-mono;
  font-size: 11px;
  text-align: right;
  color: $color-text-muted;
}

.free-note-dialog__error {
  margin-top: 12px;
  padding: 10px 12px;
  font-size: 12px;
  color: $color-error;
  background: #fff4f4;
  border-radius: 8px;
}

.free-note-dialog__confirm {
  padding: 20px 0 28px;
  font-size: 15px;
  line-height: 1.6;
}

.free-note-dialog__actions {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.free-note-dialog__button {
  padding: 0 16px;
  min-width: 84px;
  height: 40px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &--primary {
    color: #fff;
    background: $color-text;
  }

  &--secondary {
    color: $color-text;
    background: #fff;
    border-color: $color-border;
  }

  &--delete {
    margin-right: auto;
    color: $color-error;
    background: #fff;
    border-color: rgba(185, 28, 28, 0.25);
  }

  &--danger {
    color: #fff;
    background: $color-error;
  }
}

@media (max-width: 640px) {
  .free-note-dialog {
    margin: auto 0 0;
    width: 100%;
  }

  .free-note-dialog__panel {
    padding: 20px;
    border-radius: 18px 18px 0 0;
  }

  .free-note-dialog__actions {
    flex-wrap: wrap;
  }

  .free-note-dialog__button {
    flex: 1;
  }

  .free-note-dialog__button--delete {
    flex-basis: 100%;
    margin-right: 0;
  }
}
</style>
