import * as fs from "fs";
import Arweave from "arweave";
import { google } from "googleapis";

import Koa from "koa";
import Router from "@koa/router";

import { query } from "./utils";
import tipQuery from "./queries/tip.gql";

const client = new Arweave({
  host: "arweave.net",
  port: 443,
  protocol: "https",
});

const config = JSON.parse(
  fs.readFileSync("config.json", {
    encoding: "utf-8",
  })
);
const jwk = JSON.parse(
  fs.readFileSync(config.keyfile, {
    encoding: "utf-8",
  })
);

const oauthClient = new google.auth.OAuth2(
  config["clientID"],
  config["clientSecret"],
  config["endpoint"] + "/verify/callback"
);

const http = new Koa();
const router = new Router();

router.get("/ping", async (ctx, next) => {
  ctx.body = {
    status: "alive",
  };
  await next();
});

const tipReceived = async (addr: string, fee: number): Promise<boolean> => {
  const txs = (
    await query({
      query: tipQuery,
      variables: {
        owner: addr,
        recipient: await client.wallets.jwkToAddress(jwk),
      },
    })
  ).data.transactions.edges;

  if (txs.length === 1) {
    return parseFloat(txs[0].node.quantity.ar) === fee;
  }

  return false;
};

router.get("/verify", async (ctx, next) => {
  console.log("===== /verify =====");
  const addr = ctx.query["address"];

  if (!addr) {
    console.log("No address supplied.");
    ctx.status = 400;
    ctx.body = {
      status: "error",
      message: "address is required",
    };
  } else {
    console.log("Received verification request for address:\n  -", addr);
    if (await tipReceived(addr, config.fee)) {
      const uri = oauthClient.generateAuthUrl({
        scope: ["openid", "email", "profile"],
        state: JSON.stringify({ address: addr }),
      });
      ctx.body = {
        status: "success",
        uri,
      };
      console.log("Generated a unique auth URI.");
    } else {
      console.log("No tip received from this address yet.");
      ctx.status = 400;
      ctx.body = {
        status: "error",
        message: "no tip",
      };
    }
  }

  await next();
  console.log("===================\n");
});

router.get("/verify/callback", async (ctx, next) => {
  console.log("===== /verify/callback =====");

  const code = ctx.query["code"];
  const state = JSON.parse(ctx.query["state"]);
  const addr = state["address"];

  console.log("Received callback for address:\n  -", addr);

  const res = await oauthClient.getToken(code);
  if (res.tokens.access_token) {
    const info = await oauthClient.getTokenInfo(res.tokens.access_token);
    if (info.email_verified) {
      console.log("Verified email:\n  -", info.email);

      const tags = {
        "App-Name": "ArVerifyDev",
        Type: "Verification",
        Method: "Google",
        Address: addr,
      };

      const tx = await client.createTransaction(
        {
          target: addr,
          data: Math.random().toString().slice(-4),
        },
        jwk
      );

      for (const [key, value] of Object.entries(tags)) {
        tx.addTag(key, value);
      }

      await client.transactions.sign(tx, jwk);
      await client.transactions.post(tx);

      ctx.body = {
        status: "success",
        id: tx.id,
      };

      console.log("Sent Arweave transaction:\n  -", tx.id);
    } else {
      console.log("Email address is not verified.");
    }
  } else {
    console.log("No access token.");
  }

  await next();
  console.log("============================\n");
});

http.use(router.routes());

http.listen(3000);
