// =============================================================================
// useAppLoading
// Issue #153 follow-up
//
// AppLoadingOverlay は Nuxt の page:loading フックに加えて、画面遷移を伴わない
// 「ページ初期データの取得」や「ダッシュボード更新」などの長めの操作中も同じ
// 全画面アニメーションを出したい。そのためのカウンタ付きグローバル状態。
//
// 同時に複数箇所から呼ばれても閉じ忘れないよう begin/end は参照カウントにし、
// wrap(promise) で確実に finally で end を呼ぶヘルパも提供する。
// =============================================================================
const counter = ref(0);
const isManualLoading = computed(() => counter.value > 0);

export function useAppLoading() {
  function begin() {
    counter.value++;
  }
  function end() {
    counter.value = Math.max(0, counter.value - 1);
  }
  async function wrap<T>(p: Promise<T>): Promise<T> {
    begin();
    try {
      return await p;
    } finally {
      end();
    }
  }
  return { isManualLoading, begin, end, wrap };
}
