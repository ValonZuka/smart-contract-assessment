const { expect } = require("chai");
const hre = require("hardhat");

async function deployFixture() {
  const [owner, beneficiary, other] = await hre.ethers.getSigners();

  const price = hre.ethers.parseEther("0.0001");
  const Zync = await hre.ethers.getContractFactory("ZyncToken");
  const token = await Zync.deploy(price);
  await token.waitForDeployment();

  // owner treasury-mints itself a supply to fund vesting with
  const supply = hre.ethers.parseEther("1000000");
  await token.mintTo(owner.address, supply);

  const Vesting = await hre.ethers.getContractFactory("ZyncVesting");
  const vesting = await Vesting.deploy(await token.getAddress());
  await vesting.waitForDeployment();

  return { owner, beneficiary, other, token, vesting, supply };
}

describe("ZyncVesting", function () {
  describe("fund", function () {
    it("transfers tokens into the vesting contract and emits Funded", async function () {
      const { owner, token, vesting } = await deployFixture();
      const amount = hre.ethers.parseEther("1000");

      await token.connect(owner).approve(await vesting.getAddress(), amount);

      await expect(vesting.connect(owner).fund(amount))
        .to.emit(vesting, "Funded")
        .withArgs(owner.address, amount);

      expect(await token.balanceOf(await vesting.getAddress())).to.equal(amount);
    });

    it("reverts when funding with zero amount", async function () {
      const { owner, vesting } = await deployFixture();
      await expect(vesting.connect(owner).fund(0)).to.be.revertedWithCustomError(
        vesting,
        "ZeroAmount"
      );
    });
  });
  describe("release", function () {
    async function scheduledFixture({ cliff = 3600, duration = 86400, amount } = {}) {
      const ctx = await deployFixture();
      const fundAmount = hre.ethers.parseEther("10000");
      await ctx.token.connect(ctx.owner).approve(await ctx.vesting.getAddress(), fundAmount);
      await ctx.vesting.connect(ctx.owner).fund(fundAmount);

      const vestAmount = amount ?? hre.ethers.parseEther("1200"); // divisible nicely
      const latestBlock = await hre.ethers.provider.getBlock("latest");
      const start = latestBlock.timestamp + 10; // start slightly in the future

      await ctx.vesting.connect(ctx.owner).createVestingSchedule(
        ctx.beneficiary.address,
        vestAmount,
        start,
        cliff,
        duration
      );

      return { ...ctx, vestAmount, start, cliff, duration };
    }

    it("releases nothing before the cliff", async function () {
      const { beneficiary, vesting } = await scheduledFixture();

      await expect(
        vesting.connect(beneficiary).release()
      ).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    });

    it("releases proportionally between cliff and end", async function () {
      const { beneficiary, vesting, token, start, duration, vestAmount } =
        await scheduledFixture();

      // move to the halfway point of the vesting duration
      const halfway = start + Math.floor(duration / 2);
      await hre.ethers.provider.send("evm_setNextBlockTimestamp", [halfway]);
      await hre.ethers.provider.send("evm_mine");

      const releasableBefore = await vesting.releasableAmount(beneficiary.address);
      expect(releasableBefore).to.be.closeTo(
        vestAmount / 2n,
        hre.ethers.parseEther("5") // small tolerance for block timing
      );

      await expect(vesting.connect(beneficiary).release())
        .to.emit(vesting, "TokensReleased");

      const bal = await token.balanceOf(beneficiary.address);
      expect(bal).to.be.closeTo(vestAmount / 2n, hre.ethers.parseEther("5"));
    });

    it("releases full amount after duration ends", async function () {
      const { beneficiary, vesting, token, start, duration, vestAmount } =
        await scheduledFixture();

      const afterEnd = start + duration + 100;
      await hre.ethers.provider.send("evm_setNextBlockTimestamp", [afterEnd]);
      await hre.ethers.provider.send("evm_mine");

      await vesting.connect(beneficiary).release();

      const bal = await token.balanceOf(beneficiary.address);
      expect(bal).to.equal(vestAmount);
    });

    it("prevents double-claiming: second release with nothing new reverts", async function () {
      const { beneficiary, vesting, start, duration } = await scheduledFixture();

      const afterEnd = start + duration + 100;
      await hre.ethers.provider.send("evm_setNextBlockTimestamp", [afterEnd]);
      await hre.ethers.provider.send("evm_mine");

      await vesting.connect(beneficiary).release();

      await expect(
        vesting.connect(beneficiary).release()
      ).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    });

    it("allows multiple partial releases that sum to the total", async function () {
      const { beneficiary, vesting, token, start, duration, vestAmount } =
        await scheduledFixture();

      const quarter = start + Math.floor(duration / 4);
      await hre.ethers.provider.send("evm_setNextBlockTimestamp", [quarter]);
      await hre.ethers.provider.send("evm_mine");
      await vesting.connect(beneficiary).release();

      const threeQuarters = start + Math.floor((duration * 3) / 4);
      await hre.ethers.provider.send("evm_setNextBlockTimestamp", [threeQuarters]);
      await hre.ethers.provider.send("evm_mine");
      await vesting.connect(beneficiary).release();

      const afterEnd = start + duration + 100;
      await hre.ethers.provider.send("evm_setNextBlockTimestamp", [afterEnd]);
      await hre.ethers.provider.send("evm_mine");
      await vesting.connect(beneficiary).release();

      const bal = await token.balanceOf(beneficiary.address);
      expect(bal).to.equal(vestAmount);
    });

    it("reverts release() when caller has no schedule", async function () {
      const { other, vesting } = await scheduledFixture();

      await expect(
        vesting.connect(other).release()
      ).to.be.revertedWithCustomError(vesting, "NoSchedule");
    });
  });

  describe("createVestingSchedule", function () {
    async function fundedFixture() {
      const ctx = await deployFixture();
      const fundAmount = hre.ethers.parseEther("10000");
      await ctx.token.connect(ctx.owner).approve(await ctx.vesting.getAddress(), fundAmount);
      await ctx.vesting.connect(ctx.owner).fund(fundAmount);
      return { ...ctx, fundAmount };
    }

    it("creates a schedule and emits ScheduleCreated", async function () {
      const { owner, beneficiary, vesting } = await fundedFixture();
      const amount = hre.ethers.parseEther("1000");
      const now = Math.floor(Date.now() / 1000);
      const start = now;
      const cliff = 3600; // 1 hour
      const duration = 86400; // 1 day

      await expect(
        vesting.connect(owner).createVestingSchedule(
          beneficiary.address,
          amount,
          start,
          cliff,
          duration
        )
      )
        .to.emit(vesting, "ScheduleCreated")
        .withArgs(beneficiary.address, amount, start, cliff, duration);

      const schedule = await vesting.schedules(beneficiary.address);
      expect(schedule.totalAmount).to.equal(amount);
      expect(schedule.released).to.equal(0);
    });

    it("reverts when called by non-owner", async function () {
      const { beneficiary, other, vesting } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);

      await expect(
        vesting.connect(other).createVestingSchedule(
          beneficiary.address,
          hre.ethers.parseEther("100"),
          now,
          0,
          86400
        )
      ).to.be.reverted;
    });

    it("reverts when beneficiary is the zero address", async function () {
      const { owner, vesting } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);

      await expect(
        vesting.connect(owner).createVestingSchedule(
          hre.ethers.ZeroAddress,
          hre.ethers.parseEther("100"),
          now,
          0,
          86400
        )
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });

    it("reverts when amount is zero", async function () {
      const { owner, beneficiary, vesting } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);

      await expect(
        vesting.connect(owner).createVestingSchedule(
          beneficiary.address,
          0,
          now,
          0,
          86400
        )
      ).to.be.revertedWithCustomError(vesting, "ZeroAmount");
    });

    it("reverts when duration is zero", async function () {
      const { owner, beneficiary, vesting } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);

      await expect(
        vesting.connect(owner).createVestingSchedule(
          beneficiary.address,
          hre.ethers.parseEther("100"),
          now,
          0,
          0
        )
      ).to.be.revertedWithCustomError(vesting, "InvalidDuration");
    });

    it("reverts when cliff is greater than duration", async function () {
      const { owner, beneficiary, vesting } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);

      await expect(
        vesting.connect(owner).createVestingSchedule(
          beneficiary.address,
          hre.ethers.parseEther("100"),
          now,
          90000, // cliff
          86400  // duration
        )
      ).to.be.revertedWithCustomError(vesting, "CliffAfterDuration");
    });

    it("reverts when a schedule already exists for beneficiary", async function () {
      const { owner, beneficiary, vesting } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);

      await vesting.connect(owner).createVestingSchedule(
        beneficiary.address,
        hre.ethers.parseEther("100"),
        now,
        0,
        86400
      );

      await expect(
        vesting.connect(owner).createVestingSchedule(
          beneficiary.address,
          hre.ethers.parseEther("50"),
          now,
          0,
          86400
        )
      ).to.be.revertedWithCustomError(vesting, "ScheduleAlreadyExists");
    });

    it("reverts when amount exceeds unallocated funded balance", async function () {
      const { owner, beneficiary, vesting, fundAmount } = await fundedFixture();
      const now = Math.floor(Date.now() / 1000);
      const tooMuch = fundAmount + 1n;

      await expect(
        vesting.connect(owner).createVestingSchedule(
          beneficiary.address,
          tooMuch,
          now,
          0,
          86400
        )
      ).to.be.revertedWithCustomError(vesting, "InsufficientFunding");
    });
  });
});