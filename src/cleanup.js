require("dotenv").config();
const path = require("path");
const child_process = require("child_process");
const fs = require("fs-extra");
const { unload } = require("./lib/unload");

const {
  SOLA_SOLR_URL,
  SOLA_SOLR_CORE,
  SOLA_FILE_PATH,
  SOLA_HASH_PATH,
  SOLA_DB_HOST,
  SOLA_DB_PORT,
  SOLA_DB_USER,
  SOLA_DB_PWD,
  SOLA_DB_NAME,
} = process.env;

(async () => {
  console.log(`Scanning ${SOLA_HASH_PATH}`);
  const fileList = child_process
    .execSync(`find -L ${SOLA_HASH_PATH} -type f -name "*.xml.xz"`, {
      maxBuffer: 1024 * 1024 * 100,
    })
    .toString()
    .split("\n")
    .filter((each) => each);

  for (const xmlPath of fileList) {
    const mp4Path = xmlPath.replace(SOLA_HASH_PATH, SOLA_FILE_PATH).replace(".xml.xz", "");
    if (!fs.existsSync(mp4Path)) {
      console.log(`Deleting ${xmlPath}`);
      fs.removeSync(xmlPath);
    }
  }

  console.log("Connecting to mariadb");
  const knex = require("knex")({
    client: "mysql",
    connection: {
      host: SOLA_DB_HOST,
      port: SOLA_DB_PORT,
      user: SOLA_DB_USER,
      password: SOLA_DB_PWD,
      database: SOLA_DB_NAME,
    },
  });

  console.log("Checking invalid states");
  const rows = await knex("files").select("path", "status");

  for (const row of rows) {
    if (["HASHED", "LOADING", "LOADED"].includes(row.status)) {
      if (!fs.existsSync(path.join(SOLA_HASH_PATH, `${row.path}.xml.xz`))) {
        console.log(`Hash not found: ${row.path}`);
      }
    }
  }

  console.log("Looking for deleted files");
  const concurrency = 10;
  const newFiles = await knex("files").distinct("path").select("path");
  await newFiles
    .map((each) => each.path)
    .reduce((list, term, index) => {
      const i = Math.floor(index / concurrency);
      const j = index % concurrency;
      if (!list[i]) {
        list[i] = [];
      }
      list[i][j] = term;
      return list;
    }, [])
    .reduce(
      (chain, group) =>
        chain.then(() =>
          Promise.all(
            group.map(
              (filePath) =>
                new Promise(async (resolve) => {
                  if (!fs.existsSync(path.join(SOLA_FILE_PATH, filePath))) {
                    console.log(`Deleting ${filePath} from solr`);
                    await unload(filePath, SOLA_SOLR_URL, SOLA_SOLR_CORE);
                    fs.removeSync(`${path.join(SOLA_HASH_PATH, filePath)}.xml.xz`);
                    await knex("files").where("path", filePath).del();
                  }
                  resolve();
                })
            )
          )
        ),
      Promise.resolve()
    );

  await knex.destroy();

  console.log("Completed");
})();
