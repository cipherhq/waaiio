import { shortest } from "@antiwork/shortest";

shortest("On the login page, enter email from SHORTEST_DASHBOARD_EMAIL env var and password from SHORTEST_DASHBOARD_PASSWORD env var and submit. Verify successful login redirects to the dashboard").env({
  SHORTEST_DASHBOARD_EMAIL: process.env.SHORTEST_DASHBOARD_EMAIL!,
  SHORTEST_DASHBOARD_PASSWORD: process.env.SHORTEST_DASHBOARD_PASSWORD!,
});
