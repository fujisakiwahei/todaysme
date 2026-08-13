<script setup lang="ts">
defineProps<{
  durationLabel: string;
  timeLabel: string;
  nextLane: "sleep" | "calendar" | "work" | null;
  nextLaneLabel: string | null;
  nextTitle: string | null;
  noteContent: string | null;
  canEdit: boolean;
}>();

defineEmits<{
  edit: [];
}>();
</script>

<template>
  <span class="tl-free__tooltip" role="group" aria-label="空き時間の詳細">
    <span class="tl-free__tooltip-head">
      <span class="tl-free__tooltip-title">空き {{ durationLabel }}</span>
      <button
        v-if="canEdit"
        type="button"
        class="tl-free__edit"
        aria-label="空き時間メモを編集"
        @click.stop="$emit('edit')"
      >
        <span class="material-symbols-outlined" aria-hidden="true">edit</span>
      </button>
    </span>
    <span class="tl-free__tooltip-time">{{ timeLabel }}</span>
    <span v-if="noteContent" class="tl-free__tooltip-note">{{ noteContent }}</span>
    <span v-if="nextTitle && nextLane && nextLaneLabel" class="tl-free__tooltip-next">
      次:
      <span class="tl-free__tooltip-lane" :data-lane="nextLane">
        {{ nextLaneLabel }}
      </span>
      {{ nextTitle }}
    </span>
  </span>
</template>

<style lang="scss" scoped>
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
$font-en:
  "Geist",
  "Inter",
  system-ui,
  -apple-system,
  sans-serif;

.tl-free__tooltip {
  position: absolute;
  z-index: 6;
  bottom: calc(100% + 6px);
  left: 0;
  padding: 8px 12px;
  width: max-content;
  max-width: min(300px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: $font-en;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  color: #fff;
  background: rgba(26, 24, 20, 0.94);
  border-radius: 8px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
  pointer-events: auto;

  &::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 14px;
    border: 5px solid transparent;
    border-top-color: rgba(26, 24, 20, 0.94);
  }
}

.tl-free__tooltip-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.tl-free__tooltip-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.tl-free__edit {
  margin: -4px -6px -4px 0;
  width: 28px;
  height: 28px;
  display: grid;
  flex-shrink: 0;
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  border: none;
  border-radius: 50%;
  cursor: pointer;
  place-items: center;

  .material-symbols-outlined {
    font-size: 17px;
  }

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
}

.tl-free__tooltip-time {
  font-family: $font-mono;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
  font-variant-numeric: tabular-nums;
}

.tl-free__tooltip-note {
  margin-top: 4px;
  padding-top: 7px;
  max-width: 276px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-top: 1px solid rgba(255, 255, 255, 0.16);
}

.tl-free__tooltip-next {
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.82);
}

.tl-free__tooltip-lane {
  margin-right: 4px;
  padding: 1px 6px;
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 4px;

  &[data-lane="sleep"] {
    background: rgba(120, 145, 200, 0.55);
  }

  &[data-lane="calendar"] {
    background: rgba(120, 175, 140, 0.55);
  }

  &[data-lane="work"] {
    background: rgba(200, 130, 80, 0.55);
  }
}

@media (max-width: 640px) {
  .tl-free__tooltip {
    top: 100%;
    bottom: auto;
    left: 0;
    margin-top: 6px;

    &::after {
      top: auto;
      bottom: 100%;
      left: 14px;
      border-top-color: transparent;
      border-bottom-color: rgba(26, 24, 20, 0.94);
    }
  }
}
</style>
