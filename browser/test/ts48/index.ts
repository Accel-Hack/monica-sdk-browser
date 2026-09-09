import { createBrowserClient, type BrowserClientOptions } from "@ah-monica/browser";

const options: BrowserClientOptions = {
  dsn: "https://mpk_public@example.test/1",
  environment: "test",
  route: "/issues/{issueId}",
};

const client = createBrowserClient(options);
void client.captureMessage("TypeScript 4.8 can read these declarations");
