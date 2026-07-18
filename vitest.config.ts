import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        workers: [
          {
            name: "serviceeast",
            modules: true,
            script: `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export class ServiceLookup extends WorkerEntrypoint {
                async getCurrentJobs() {
                  return { checkedAt: "", totalJobs: 0, jobs: [] };
                }
              }
              export default { fetch() { return new Response("test service"); } };
            `,
          },
        ],
      },
    }),
  ],
});
