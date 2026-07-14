const { expect } = require("chai");
const hre = require("hardhat");

describe("ZyncToken", function () {
  it("mints ZYNC for ETH at the public price", async function () {
    const [, buyer] = await hre.ethers.getSigners();
    const price = hre.ethers.parseEther("0.001");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    const tx = await token.connect(buyer).mintWithEth({ value: price });
    await tx.wait();

    const bal = await token.balanceOf(buyer.address);
    expect(bal).to.equal(hre.ethers.parseEther("1"));

    expect(await hre.ethers.provider.getBalance(await token.getAddress())).to.equal(price);
  });

  it("reverts when owner tries to set mint price to zero", async function () {
    const price = hre.ethers.parseEther("0.001");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await expect(token.setMintPrice(0)).to.be.revertedWithCustomError(
      token,
      "ZeroMintPrice"
    );

    expect(await token.mintPriceWei()).to.equal(price);
  });

  it("allows owner to update mint price to a valid nonzero value", async function () {
    const price = hre.ethers.parseEther("0.001");
    const newPrice = hre.ethers.parseEther("0.002");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await token.setMintPrice(newPrice);
    expect(await token.mintPriceWei()).to.equal(newPrice);
  });

  it("refunds excess ETH when division causes rounding (msg.value not evenly divisible)", async function () {
    const [, buyer] = await hre.ethers.getSigners();
    const price = 333n; // deliberately awkward price in wei to force truncation
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    const sent = 1000n; // arbitrary wei amount, not a clean multiple of price

    // mirror the contract's math to compute expected values
    const expectedTokenAmount = (sent * 10n ** 18n) / price;
    const expectedCostWei = (expectedTokenAmount * price) / 10n ** 18n;
    const expectedRefund = sent - expectedCostWei;

    const balBefore = await hre.ethers.provider.getBalance(buyer.address);

    const tx = await token.connect(buyer).mintWithEth({ value: sent });
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;

    const balAfter = await hre.ethers.provider.getBalance(buyer.address);

    // buyer paid exactly expectedCostWei + gas
    expect(balBefore - balAfter - gasCost).to.equal(expectedCostWei);

    const tokenBal = await token.balanceOf(buyer.address);
    expect(tokenBal).to.equal(expectedTokenAmount);

    expect(
      await hre.ethers.provider.getBalance(await token.getAddress())
    ).to.equal(expectedCostWei);

    // sanity check: this scenario should actually produce a nonzero refund
    expect(expectedRefund).to.be.greaterThan(0n);
  });
  it("reverts with ZeroAmount when msg.value is zero", async function () {
    const price = hre.ethers.parseEther("0.001");
    const [, buyer] = await hre.ethers.getSigners();
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await expect(
      token.connect(buyer).mintWithEth({ value: 0 })
    ).to.be.revertedWithCustomError(token, "ZeroAmount");
  });
});