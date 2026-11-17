import type { FakeHost } from "pomade-kit/fake-host";

declare global {
  interface Window {
    fakeHost: FakeHost;
  }
}
