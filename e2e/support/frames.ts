// App frames in a real Pomade.

import type { Page } from "@playwright/test";

/** Wait until Pomade's window has drawn an app frame it just showed (a side panel or a tab brought
 *  back): five of the window's animation frames. A frame just shown takes pointer input only once
 *  the window has drawn it; a click sent earlier is dropped (Pomade's HOST-API §5). */
export async function drawn(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        let left = 5;
        const step = (): void => {
          left -= 1;
          if (left === 0) done();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
}
