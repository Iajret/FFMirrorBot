const fs = require("fs");
const axios = require("axios");
const { execSync } = require("child_process");
const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");

const config = require("./config.json");

const pollInterval = config.pollInterval * 1000;

const upstreamPath = "https://github.com/Skyrat-SS13/Skyrat-tg.git";
const skyratrepo = "Skyrat-SS13/Skyrat-tg".split("/");
const skyratrepoOwner = skyratrepo[0];
const skyratrepoName = skyratrepo[1];

//only used to get original PR author for changelogs
const TGrepo = "tgstation/tgstation".split("/");
const TGrepoOwner = TGrepo[0];
const TGrepoName = TGrepo[1];

const authKey = fs.readFileSync(
  config.keyPath,
  "utf8",
);

const repoPath = config.repoPath;

const githubClient = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: config.appID,
    privateKey: authKey,
    installationId: config.installationID,
  },
});

async function getCommitsToPoint(sha) {
  let commits = [];
  let iterator;
  
  iterator = githubClient.paginate.iterator(githubClient.rest.repos.listCommits,{
    owner: skyratrepoOwner,
    repo: skyratrepoName,
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
    };
  };
  if (commits.length == 0) {return {commits: commits, lastSHA: sha}};
  let lastSHA = commits[commits.length - 1].SHA;
  return {commits: commits, lastSHA: lastSHA}
};

async function getPRdata(id, repo) {
  let PR = await githubClient.rest.pulls.get({
    owner: repo[0],
    repo: repo[1],
    pull_number: id,
  });
  return PR.data
}

function mirrorPR(PR){
  let labels = [];
  let prCreateResponse;
  
  if(PR.configUpdate) labels.push("Configs");

  //updates local repo from target remote and cleans it
  execSync("git checkout master && git fetch mirror master && git reset --hard origin/master", { cwd: repoPath });
  try{
    execSync(`git checkout -b upstream-mirror-${PR.id} && git cherry-pick ${PR.mergeCommit.SHA}`, { cwd: repoPath });
  }
  catch{
    execSync("git add -A . && git -c core.editor=true cherry-pick --continue", { cwd: repoPath }); //theres conflicts, proceed regardless. No way to see where's exactly
    console.info(`Conflict while merging with ${PR.id}`);
    labels.push("Mirroring conflict");
  }

  execSync(`git push origin upstream-mirror-${PR.id}`, { cwd: repoPath });
  execSync(`git checkout master && git branch -D upstream-mirror-${PR.id}`, { cwd: repoPath }); //returning to master and cleaning after ourselves

    githubClient.rest.pulls.create({
      owner: "Iajret",
      repo: "FluffySTG",
      head: `upstream-mirror-${PR.id}`,
      base: "master",
      title: PR.title,
      body: PR.info,
    }).then((result) => {
      prCreateResponse = result.data
      if(labels.length > 0){
        let mirrorID = prCreateResponse?.number;
          githubClient.rest.issues.addLabels({
            owner: "Iajret",
            repo: "FluffySTG",
            issue_number: mirrorID,
            labels: labels,
          }).catch((error) => {
            screamOutLoud(`Error while labeling PR #${PR.id}\n` + error.message);
            console.log(`Error while labeling PR #${PR.id}\n`, error.message);
          });
        };
      }).catch((error) => {
        screamOutLoud(`Error while mirroring PR #${PR.id}\n` + error.message);
        console.log(`Error while mirroring PR #${PR.id}\n`, error.message);
      })
};

//executes once just to make sure our local repo is properly set
function gitPreCheck(){
  try {
    execSync(`git remote add mirror ${upstreamPath}`, { cwd: repoPath })}
  catch{
    console.info("Remote already set or URL is invalid")
  }
};

function screamOutLoud(message){
  axios.post(config.webhookURL, {
    content: "<@198894472954773504>\n" + message,
  })
};

gitPreCheck();

(function pollLoop() {
  setTimeout(() => {
    let lastCommit = fs.readFileSync("./lastSha.txt", "utf8");

    getCommitsToPoint(lastCommit)
    .catch((error) => console.log(`${error?.message}`))
    .then((result) => {
      if(result.commits){
        for(let commit of result.commits){
          let PR = commit.PR;
          console.log(`Mirroring #${PR.id}: "${PR.title}" with its commit sha ${commit.SHA}`);
          mirrorPR(PR);
          fs.writeFileSync("./lastSha.txt", commit.SHA);
        };
        //if (lastSHA != result.lastSHA) console.log("Failed to mirror all PRs");
      }
    });
    pollLoop();
  }, pollInterval);
})();

class Commit{
  constructor(SHA, info){
    this.SHA = SHA;
    this.info = info;
    let PRNumber = info.match(/\(#[0-9]+\)/);
    if(PRNumber) {
      this.PRid = PRNumber[PRNumber.length - 1].replace(/[\(|#|\)]/g, "");
      let PR = new PullRequest(this);
      //PR.resolvePR();
      this.PR = PR;
    }
  }
}

class PullRequest{
  constructor(commit){
    this.mergeCommit = commit;
    this.id = commit.PRid;
  };

  async resolvePR(){
    let data = await getPRdata(this.id, skyratrepo);
    this.title = data.title;
    this.url = data.html_url;
    this.patch = data.patch_url;
    this.info = data.body; 
    this.creator = data.user.login;
    if (this.title.startsWith("[MIRROR]") || this.title.startsWith("[MISSED MIRROR]")){ //true => TG mirror, so we need to get some additional info
      let urlLine = this.info.split("\n")[0];
      this.urlTG = urlLine.slice(13);
      this.idTG = this.urlTG.match(/[0-9]+/);
      data = await getPRdata(this.idTG, TGrepo);
      this.creator = data.user.login;
    }
    this.compileData();
  };

  compileData(){
    if(this.title.toLowerCase().includes("mirror") && !this.urlTG) console.log('PR ', this.id, 'had "mirror" in its name but missed original url.' );
    //console.log(this.title);
    //try to get author name from :cl: thingy
    let clBody = this.info.split(":cl:");
    if(clBody[1]){
      let authors = clBody[1].split("\n")[0];
      if (authors.length > 1) this.creator = ""; // then we dont need to add anything, it's already here
      clBody[1] = " " + this.creator + clBody[1];
      this.info = clBody.join(":cl:");
    };
    this.configUpdate = this.info.includes("config: ");
    //this.info = this.info.replace(/https:\/\/[\S]+/, "(original url)") //delete this you dumbass

    this.title = this.urlTG ? this.title.replace(/(\[[A-Za-z\s]*\])/, "[TG Mirror]") : "[Skyrat Mirror] " + this.title;
    this.title.replace("[MDB IGNORE]", "");
    this.title.replace("[NO GBP]", "");
    this.info = (this.urlTG ? `Mirrored on Skyrat: ${this.url}\n` : `## **Original PR: ${this.url}**\n`) + this.info;
    //console.log("Title: ", this.title, "\nBody: ", this.info);
  }
}
