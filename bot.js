const fs = require("fs");
const { execSync } = require("child_process");

const axios = require("axios");

const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const { throttling } = require("@octokit/plugin-throttling");

const config = require("./config.json");

const pollInterval = config.pollInterval * 1000;

const ourRepo = "Fluffy-Frontier/FluffySTG".split("/");
const ourRepoOwner = ourRepo[0];
const ourRepoName = ourRepo[1];

const upstreamPath = "https://github.com/Skyrat-SS13/Skyrat-tg.git";
const skyratRepo = "Skyrat-SS13/Skyrat-tg".split("/");
const skyratRepoOwner = skyratRepo[0];
const skyratRepoName = skyratRepo[1];

//only used to get original PR author for changelogs
const TGRepo = "tgstation/tgstation".split("/");

const repoPath = config.repoPath;

const MyOctokit = Octokit.plugin(retry, throttling);
const githubClient = new MyOctokit({
  auth: config.key,
  userAgent: "FFMirrorBot",
  throttle: {
    onRateLimit: (retryAfter, options) => {
      if (options.request.retryCount <= 10) {
        console.info(`Primary quota reached. Retrying after ${retryAfter} seconds!`);
        return true;
      }
      console.warn(`Request ${options.method} ${options.url} failed after 5 retries.`);
      screamOutLoud(`Request ${options.method} ${options.url} failed after 5 retries.`);
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      if (options.request.retryCount <= 10) {
        console.info(`Secondary quota reached. Retrying after ${retryAfter} seconds!`);
        return true;
      }
      console.warn(`Request ${options.method} ${options.url} failed after 5 retries.`);
      screamOutLoud(`Request ${options.method} ${options.url} failed after 5 retries.`);
    },
  },
});

async function getCommitsToPoint(sha) {
  let commits = [];
  let iterator;
  
  iterator = githubClient.paginate.iterator(githubClient.rest.repos.listCommits,{
    owner: skyratRepoOwner,
    repo: skyratRepoName,
    per_page: 100,
  });

  paginateLoop:
  for await (const { data: rawCommits } of iterator) {
    for(let rawCommit of rawCommits){
      let commitsha = rawCommit.sha;
      if (commitsha.startsWith(sha)) break paginateLoop;
      let info = rawCommit.commit.message;
      if(info.includes("Automatic changelog")) continue;
      let commit = new Commit(commitsha, info);
      if (!commit.PR) {screamOutLoud("Commit: " + commit.info + "\ndoesn't have attached PR to mirror."); continue;}
      await commit.PR.resolvePR();
      commits.unshift(commit);
    }
  }
  if (commits.length === 0) {return {commits: commits, lastSHA: sha}}
  let lastSHA = commits[commits.length - 1].SHA
  return {commits: commits, lastSHA: lastSHA}
}

async function getPRdata(id, repo) {
  let PR = await githubClient.rest.pulls.get({
    owner: repo[0],
    repo: repo[1],
    pull_number: id,
  })
  return PR.data
}

function mirrorPR(PR){
  let labels = [];
  let prCreateResponse;
  
  if(PR.configUpdate) labels.push("Configs");
  PR.urlTG ? labels.push("TG Mirror") : labels.push("Skyrat Mirror")

  //updates local repo from target remote and cleans it
  execSync("git checkout master && git pull --depth 1000 origin master && git fetch --depth 1000 mirror master && git reset --hard origin/master", { cwd: repoPath });
  try{
    execSync(`git checkout -b upstream-mirror-${PR.id} && git cherry-pick ${PR.mergeCommit.SHA} --allow-empty --keep-redundant-commits`, { cwd: repoPath });
  }
  catch{
    execSync("git add -A . && git -c core.editor=true cherry-pick --continue", { cwd: repoPath }); //theres conflicts, proceed regardless. No way to see where's exactly
    console.info(`Conflict while merging with ${PR.id}`);
    labels.push("Mirroring conflict");
  }

  execSync(`git push origin upstream-mirror-${PR.id}`, { cwd: repoPath });
  execSync(`git checkout master && git branch -D upstream-mirror-${PR.id}`, { cwd: repoPath }); //returning to master and cleaning after ourselves

  githubClient.rest.pulls.create({
    owner: ourRepoOwner,
    repo: ourRepoName,
    head: `upstream-mirror-${PR.id}`,
    base: "master",
    title: PR.title,
    body: PR.info,
  }).then((result) => {
    prCreateResponse = result.data
    if(labels.length > 0){
      let mirrorID = prCreateResponse?.number;
        githubClient.rest.issues.addLabels({
          owner: ourRepoOwner,
          repo: ourRepoName,
          issue_number: mirrorID,
          labels: labels,
        }).catch((error) => {
          screamOutLoud(`Error while labeling PR #${PR.id}\n` + error.message);
          console.log(`Error while labeling PR #${PR.id}\n`, error.message);
        })
      }
    }).catch((error) => {
      screamOutLoud(`Error while mirroring PR #${PR.id}\n` + error.message);
      console.log(`Error while mirroring PR #${PR.id}\n`, error.message);
    })
}

//executes once just to make sure our local repo is properly set
function gitPreCheck(){
  try {
    execSync(`git remote add mirror ${upstreamPath}`, { cwd: repoPath })}
  catch{
    console.info("Remote already set or URL is invalid")
  }
}

function screamOutLoud(message){
  axios.post(config.webhookURL, {
    content: `<@${config.pingID}>\n ${message}`,
  })
}

gitPreCheck();
screamOutLoud("Я живое");

(function pollLoop() {
  setTimeout(() => {
    let lastCommit
    try{
      lastCommit = fs.readFileSync("./lastSha.txt", "utf8");
    } catch {
      fs.writeFileSync("./lastSha.txt", "add last commit here");
      throw Error("lastSHA created. Add last commit hash to it and restart.")
    }

    getCommitsToPoint(lastCommit)
    .catch((error) => console.log(`${error?.message}`))
    .then((result) => {
      if(result.commits){
        for(let commit of result.commits){
          let PR = commit.PR;
          console.log(`Mirroring #${PR.id}: "${PR.title}" with its commit sha ${commit.SHA}`);
          mirrorPR(PR);
          fs.writeFileSync("./lastSha.txt", commit.SHA);
        }
        //if (lastSHA != result.lastSHA) console.log("Failed to mirror all PRs");
      }
    });
    pollLoop();
  }, pollInterval);
})();

process.on("uncaughtException", (err, origin) => {
  screamOutLoud(`${err}\n\n${origin}`);
  setTimeout(() =>   process.exit(1), 100)
})

class Commit{
  constructor(SHA, info){
    this.SHA = SHA;
    this.info = info;
    let PRNumber = info.match(/\(#[0-9]+\)/);
    if(PRNumber) {
      this.PRid = PRNumber[PRNumber.length - 1].replace(/[(|#)]/g, "");
      this.PR = new PullRequest(this);
    }
  }
}

class PullRequest{
  constructor(commit){
    this.mergeCommit = commit;
    this.id = commit.PRid;
  };

  async resolvePR(){
    let data = await getPRdata(this.id, skyratRepo);
    this.title = data.title;
    this.url = data.html_url;
    this.info = data.body; 
    this.creator = data.user.login;
    if (this.title.startsWith("[MIRROR]") || this.title.startsWith("[MISSED MIRROR]")){ //true => TG mirror, so we need to get some additional info
      let urlLine = this.info.split("\n")[0];
      this.urlTG = urlLine.slice(13);
      this.idTG = this.urlTG.match(/[0-9]+/);
      data = await getPRdata(this.idTG, TGRepo);
      this.creator = data.user.login;
    }
    this.compileData();
  };

  compileData(){
    if(this.title.toLowerCase().includes("mirror") && !this.urlTG) console.warn('PR ', this.id, 'had "mirror" in its name but missed original url.' );

    //try to get author name from :cl: thingy
    let clBody = this.info.split(":cl:");
    if(clBody[1]){
      let authors = clBody[1].split("\n")[0];
      if (authors.length > 1) this.creator = ""; // then we dont need to add anything, it's already here
      clBody[1] = " " + this.creator + clBody[1];
      this.info = clBody.join(":cl:");
    }
    this.configUpdate = this.info.includes("config: ");
    if(this.title.search(/\[MIRROR]/) < 0) this.title = `[MIRROR] ${this.title}`
    this.title = this.title.replace(/(\[(MDB IGNORE|NO GBP)])/g, "");
    this.info = (this.urlTG ? `Mirrored on Skyrat: ${this.url}\n` : `## **Original PR: ${this.url}**\n`) + this.info;
  }
}
