/**
 * web/test/helpers/dom-stub.ts — `node:vm` 실행 하네스가 쓰는 최소 DOM 스텁, **한 벌**.
 *
 * ## 왜 한 벌인가
 *
 * 이 파일이 생기기 전 같은 `class El`이 **4벌** 복제돼 있었다
 * (`ui-confirm` · `ui-doc-state` · `ui-gen-estimate-rows` · `ui-hierarchy`).
 * 그리고 **이미 갈라져 있었다** — `ui-confirm`에는 `classList.toggle`이 아예 없었고,
 * `setAttribute`는 셋에서 no-op인데 하나에서만 실제 저장이었다.
 *
 * CLAUDE.md 안전 원칙 5: **"단일 관문을 선언해 놓고 사본을 남기면 원본의 정정이 사본에
 * 도달하지 않는다."** 스텁은 "코드처럼 생기지 않은 자리"라 정확히 그 함정에 들어맞는다 —
 * 하네스가 실제 DOM과 어긋나면 **그 위에서 도는 테스트는 전부 같은 허구를 본다.**
 *
 * ## 이 스텁이 실제 DOM과 다른 점 (의도된 한계)
 *
 * CSS 엔진이 없다. 따라서 **계산된 스타일(`getComputedStyle`)을 볼 수 없고**, 클래스가
 * 실제로 요소를 숨기는지 판정할 수 없다. 그 축은 브라우저(E2E)에서만 잴 수 있다 —
 * 이 하네스로 "보이는지"를 단언하려 하지 마라. 여기서 잴 수 있는 것은 **`hidden` 속성의
 * 값**이지 그 값이 만드는 시각적 결과가 아니다.
 */

export interface DomStubOptions {
  /**
   * 자식들의 `textContent`를 이을 때 쓰는 구분자.
   *
   * ⚠️ **통일하지 않고 파라미터로 남긴 이유** — 복제본 넷 중 `ui-confirm`만 `""`이고 나머지
   * 셋은 `"\n"`이었다. 조용히 하나로 합치면 `findButton(text)`의 **정확 일치 비교가 달라져**
   * 이 Step이 건드리지 않기로 한 테스트의 의미가 바뀐다. 하네스 단일화는 스텁을 합치는
   * 작업이지 테스트의 판정 기준을 바꾸는 작업이 아니다 — 호출부가 **현재 값**을 명시한다.
   */
  readonly textJoin: string;
}

/**
 * `El` 클래스를 만든다. 타입으로도 쓰려면 호출부에서 값과 타입을 같은 이름으로 선언한다:
 *
 * ```ts
 * const El = createElClass({ textJoin: "\n" });
 * type El = InstanceType<typeof El>;
 * ```
 */
export function createElClass(options: DomStubOptions) {
  class El {
    children: El[] = [];
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    classes = new Set<string>();
    className = "";
    disabled = false;
    value = "";
    style: Record<string, string> = {};
    attrs = new Map<string, string>();

    /**
     * `hidden` IDL 프로퍼티. **B3 Step 1(D-1)이 쓸 축이다.**
     *
     * 실제 브라우저에서 `el.hidden = true`는 `hidden` 속성을 붙이고, CSS의
     * `[hidden]{display:none!important}`가 그것을 숨긴다. 스텁에는 CSS가 없으므로 여기서
     * 잴 수 있는 것은 **불리언 값 자체**뿐이다(위 「의도된 한계」 참조).
     *
     * ⚠️ 이 필드가 `classList` 기반 토글보다 나은 이유는 편의가 아니다 — **불리언 대입은
     * 스텁이 틀리게 모델링할 여지가 없다.** 아래 `classList.toggle`의 주석이 그 반례다.
     */
    hidden = false;

    #text = "";

    constructor(readonly tag: string) {}

    get textContent(): string {
      return this.#text || this.children.map((c) => c.textContent).join(options.textJoin);
    }

    /** 핵심 의미 — 텍스트를 넣으면 자식이 **떨어져 나간다.** 결함의 발생 지점이 정확히 여기다. */
    set textContent(value: string) {
      this.#text = value;
      this.children = [];
    }

    appendChild(child: El): El {
      this.#text = "";
      this.children.push(child);
      return child;
    }

    addEventListener(type: string, fn: (...args: unknown[]) => void): void {
      const existing = this.listeners.get(type) ?? [];
      existing.push(fn);
      this.listeners.set(type, existing);
    }

    /**
     * 속성 3종은 **한 벌로 맞물려야 한다.** 이전에는 `setAttribute`가 셋에서 no-op이고
     * 하나에서만 저장이었는데, 저장하는 쪽만 `getAttribute`를 가졌다. 저장을 표준으로
     * 올린다 — no-op은 "값을 못 읽는다"가 아니라 **읽으면 항상 `null`**이라 "설정한 적 없음"과
     * "설정했는데 안 보임"을 뭉갠다(안전 원칙 7).
     */
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, value);
    }

    getAttribute(name: string): string | null {
      return this.attrs.get(name) ?? null;
    }

    /**
     * ⚠️ 이전 복제본 셋에서 **no-op**이었다. `ui-page.ts`는 이 메서드를 **한 번도 부르지
     * 않으므로**(실측 0건) no-op이 아무것도 깨뜨리지 않았을 뿐이다. `setAttribute`가 실제로
     * 저장하게 된 이상 no-op을 남기면 "지웠는데 남아 있는" 상태가 만들어진다 — 맞물리게 한다.
     */
    removeAttribute(name: string): void {
      this.attrs.delete(name);
    }

    click(): void {
      for (const fn of this.listeners.get("click") ?? []) fn();
    }

    querySelectorAll(): El[] {
      return [];
    }

    classList = {
      add: (c: string) => this.classes.add(c),
      remove: (c: string) => this.classes.delete(c),
      contains: (c: string) => this.classes.has(c),
      /**
       * ⚠️ **복제본 넷 전부가 두 번째 인자(`force`)를 무시했다.** 실제 `ui-page.ts`는
       * `classList.toggle("hidden", which !== "assets")`처럼 **force를 넘겨서** 부른다 —
       * 즉 스텁은 실제 DOM과 **다르게 동작**하고 있었다(같은 값으로 두 번 부르면 실제
       * DOM은 그대로인데 스텁은 뒤집힌다).
       *
       * 이 결함이 지금까지 아무것도 깨뜨리지 않은 이유는 **유일한 호출자 `showTab`이 실행
       * 커버리지가 없어서**다 — "틀린 도구로, 안 돌린 코드를 재고 있었다." 여기서 충실도를
       * 맞춘다.
       */
      toggle: (c: string, force?: boolean) => {
        const next = force === undefined ? !this.classes.has(c) : force;
        if (next) this.classes.add(c);
        else this.classes.delete(c);
        return next;
      },
    };

    /**
     * 하위 트리에서 **보이는 글자**로 버튼을 찾는다 — 사용자가 화면에서 찾는 방식과 같다.
     *
     * ⚠️ 아래 `findButtonByText`와 **일부러 다르다.** 이쪽은 자식까지 이어붙인
     * `textContent`를 보고, 저쪽은 자기 자신에게 직접 넣힌 텍스트만 본다. 둘을 하나로
     * 합치면 기존 두 테스트 파일 중 하나의 판정 기준이 조용히 바뀐다 — 합치기는 **의미를
     * 보존하는 작업**이므로 둘 다 남긴다.
     */
    findButton(text: string): El | null {
      if (this.tag === "button" && this.textContent === text) return this;
      for (const child of this.children) {
        const hit = child.findButton(text);
        if (hit !== null) return hit;
      }
      return null;
    }

    /** `tag==="button"`이고 **직접 넣힌** 글자가 정확히 일치하는 첫 버튼(위 주석 참조). */
    findButtonByText(text: string): El | null {
      if (this.tag === "button" && this.#text === text) return this;
      for (const child of this.children) {
        const hit = child.findButtonByText(text);
        if (hit !== null) return hit;
      }
      return null;
    }

    find(className: string): El | null {
      if (this.className === className) return this;
      for (const child of this.children) {
        const hit = child.find(className);
        if (hit !== null) return hit;
      }
      return null;
    }
  }

  return El;
}
