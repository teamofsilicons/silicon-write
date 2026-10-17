// Signs up a new Carbon on the local Silicon Accounts stack and prints {email, id, uuid}.
//   node crates/write-cli/e2e/carbon.mjs LABEL
import { signUpCarbon } from "../../../e2e/lib/stack.mjs";

const carbon = await signUpCarbon(process.argv[2] ?? "carbon");
console.log(JSON.stringify({ email: carbon.email, id: carbon.id, uuid: carbon.uuid }));
