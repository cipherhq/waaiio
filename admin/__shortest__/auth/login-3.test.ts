import { shortest } from "@antiwork/shortest";

shortest("On the admin login page, enter email from SHORTEST_ADMIN_EMAIL and password from SHORTEST_ADMIN_PASSWORD env vars and submit. Verify successful login redirects to the admin dashboard").env({
  SHORTEST_ADMIN_EMAIL: process.env.SHORTEST_ADMIN_EMAIL!,
  SHORTEST_ADMIN_PASSWORD: process.env.SHORTEST_ADMIN_PASSWORD!,
});
