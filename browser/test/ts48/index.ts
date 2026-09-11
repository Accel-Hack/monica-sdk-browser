import { createBrowserClient, type BrowserClientOptions } from "@ah-monica/browser";

const options: BrowserClientOptions = {
  dsn: "https://mpk_public@example.test/1",
  environment: "test",
  route: "/issues/{issueId}",
  onDiagnostic(diagnostic) {
    void diagnostic.status;
    void diagnostic.error?.code;
    void diagnostic.issues?.map((issue) => `${issue.path}: ${issue.message}`);
  },
};

const client = createBrowserClient(options);
void client.captureMessage("TypeScript 4.8 can read these declarations");
void client.flush().then((result) => result.diagnostics?.length);
