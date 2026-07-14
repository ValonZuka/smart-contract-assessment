const hre = require("hardhat");

async function main() {
  const tokenAddress = process.env.ZYNC_TOKEN_ADDRESS;
  if (!tokenAddress) {
    throw new Error(
      "ZYNC_TOKEN_ADDRESS is not set. Deploy ZyncToken first and set it in your .env."
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying ZyncVesting with:", deployer.address);
  console.log("Using ZyncToken at:", tokenAddress);

  const Vesting = await hre.ethers.getContractFactory("ZyncVesting");
  const vesting = await Vesting.deploy(tokenAddress);
  await vesting.waitForDeployment();
  const addr = await vesting.getAddress();
  console.log("ZyncVesting:", addr);

  // Optional: fund the vesting contract on deploy if FUND_AMOUNT_WEI is set.
  const fundAmount = process.env.FUND_AMOUNT_WEI;
  if (fundAmount) {
    const Zync = await hre.ethers.getContractFactory("ZyncToken");
    const token = Zync.attach(tokenAddress);

    console.log("Approving and funding vesting contract with:", fundAmount);
    const approveTx = await token.approve(addr, fundAmount);
    await approveTx.wait();

    const fundTx = await vesting.fund(fundAmount);
    await fundTx.wait();
    console.log("Vesting contract funded.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});