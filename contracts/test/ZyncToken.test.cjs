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
  it("allows a holder to burn their own tokens and emits Burned", async function () {
    const [, buyer] = await hre.ethers.getSigners();
    const price = hre.ethers.parseEther("0.001");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await token.connect(buyer).mintWithEth({ value: price });
    const burnAmount = hre.ethers.parseEther("0.4");

    await expect(token.connect(buyer).burn(burnAmount))
      .to.emit(token, "Burned")
      .withArgs(buyer.address, burnAmount);

    const bal = await token.balanceOf(buyer.address);
    expect(bal).to.equal(hre.ethers.parseEther("0.6"));
  });

  it("reverts when burning more than the caller's balance", async function () {
    const [, buyer] = await hre.ethers.getSigners();
    const price = hre.ethers.parseEther("0.001");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await token.connect(buyer).mintWithEth({ value: price });
    const tooMuch = hre.ethers.parseEther("2");

    await expect(token.connect(buyer).burn(tooMuch)).to.be.reverted;
  });

  it("allows burnFrom with sufficient allowance and emits Burned", async function () {
    const [, buyer, spender] = await hre.ethers.getSigners();
    const price = hre.ethers.parseEther("0.001");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await token.connect(buyer).mintWithEth({ value: price });
    const burnAmount = hre.ethers.parseEther("0.3");

    await token.connect(buyer).approve(spender.address, burnAmount);

    await expect(
      token.connect(spender).burnFrom(buyer.address, burnAmount)
    )
      .to.emit(token, "Burned")
      .withArgs(buyer.address, burnAmount);

    const bal = await token.balanceOf(buyer.address);
    expect(bal).to.equal(hre.ethers.parseEther("0.7"));
  });

  it("reverts burnFrom without sufficient allowance", async function () {
    const [, buyer, spender] = await hre.ethers.getSigners();
    const price = hre.ethers.parseEther("0.001");
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    await token.connect(buyer).mintWithEth({ value: price });

    // no approval given
    await expect(
      token.connect(spender).burnFrom(buyer.address, hre.ethers.parseEther("0.1"))
    ).to.be.reverted;
  });

  it("does not allow burned tokens to free up additional mint capacity beyond MAX_SUPPLY", async function () {
    const price = 1n; // 1 wei per full token, so we can mint the full cap cheaply
    const Z = await hre.ethers.getContractFactory("ZyncToken");
    const token = await Z.deploy(price);
    await token.waitForDeployment();

    const maxSupply = await token.MAX_SUPPLY();

    // mint the entire cap via owner treasury mint
    await token.mintTo(await token.owner(), maxSupply);
    expect(await token.totalMinted()).to.equal(maxSupply);

    // burn some tokens
    const burnAmount = hre.ethers.parseEther("1000");
    await token.burn(burnAmount);

    // totalSupply drops, but totalMinted must NOT drop
    expect(await token.totalMinted()).to.equal(maxSupply);

    // attempting to mint again, even a small amount, should still fail
   await expect(token.mintTo(await token.owner(), 1)).to.be.revertedWithCustomError(
      token,
      "CapExceeded"
    );
  });
});