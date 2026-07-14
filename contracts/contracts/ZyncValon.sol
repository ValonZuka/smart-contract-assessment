// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ZyncVesting — linear token vesting with a cliff for ZYNC
/// @notice Admin funds the contract, then creates one vesting schedule per
///         beneficiary. Beneficiaries call release() to claim tokens that
///         have vested linearly between `cliff` and `start + duration`.
contract ZyncVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct VestingSchedule {
        uint256 totalAmount;
        uint256 released;
        uint64 start;
        uint64 cliff;
        uint64 duration;
    }

    IERC20 public immutable token;

    /// Total tokens allocated across all schedules (may be < contract balance if extra funded).
    uint256 public totalAllocated;

    mapping(address => VestingSchedule) public schedules;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidDuration();
    error CliffAfterDuration();
    error ScheduleAlreadyExists();
    error InsufficientFunding();
    error NoSchedule();
    error NothingToRelease();

    event Funded(address indexed from, uint256 amount);
    event ScheduleCreated(
        address indexed beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliff,
        uint64 duration
    );
    event TokensReleased(address indexed beneficiary, uint256 amount);

    constructor(address tokenAddress) Ownable(msg.sender) {
        if (tokenAddress == address(0)) revert ZeroAddress();
        token = IERC20(tokenAddress);
    }

    /// @notice Fund this contract with ZYNC to be allocated to vesting schedules.
    /// @dev Caller must have approved this contract for `amount` beforehand.
    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Create a linear vesting schedule for `beneficiary`.
    /// @param beneficiary Address that will be able to claim vested tokens.
    /// @param amount Total tokens to vest.
    /// @param start Unix timestamp when vesting begins.
    /// @param cliff Seconds after `start` before any tokens vest.
    /// @param duration Total seconds over which tokens vest linearly (from `start`).
    function createVestingSchedule(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliff,
        uint64 duration
    ) external onlyOwner {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (duration == 0) revert InvalidDuration();
        if (cliff > duration) revert CliffAfterDuration();
        if (schedules[beneficiary].totalAmount != 0) revert ScheduleAlreadyExists();

        uint256 available = token.balanceOf(address(this)) - totalAllocated;
        if (amount > available) revert InsufficientFunding();

        totalAllocated += amount;
        schedules[beneficiary] = VestingSchedule({
            totalAmount: amount,
            released: 0,
            start: start,
            cliff: cliff,
            duration: duration
        });

        emit ScheduleCreated(beneficiary, amount, start, cliff, duration);
    }

    /// @notice Claim all currently releasable tokens for the caller.
    function release() external nonReentrant {
        VestingSchedule storage schedule = schedules[msg.sender];
        if (schedule.totalAmount == 0) revert NoSchedule();

        uint256 releasable = _releasableAmount(schedule);
        if (releasable == 0) revert NothingToRelease();

        // Effects before interaction (CEI) — prevents double-claiming/reentrancy.
        schedule.released += releasable;
        totalAllocated -= releasable;

        token.safeTransfer(msg.sender, releasable);

        emit TokensReleased(msg.sender, releasable);
    }

    /// @notice View how many tokens are currently releasable for `beneficiary`.
    function releasableAmount(address beneficiary) external view returns (uint256) {
        return _releasableAmount(schedules[beneficiary]);
    }

    /// @notice View total vested (released + releasable) tokens at current time.
    function vestedAmount(address beneficiary) external view returns (uint256) {
        return _vestedAmount(schedules[beneficiary]);
    }

    function _releasableAmount(VestingSchedule storage schedule) internal view returns (uint256) {
        return _vestedAmount(schedule) - schedule.released;
    }

    function _vestedAmount(VestingSchedule storage schedule) internal view returns (uint256) {
        if (schedule.totalAmount == 0) return 0;

        uint256 cliffTime = uint256(schedule.start) + uint256(schedule.cliff);
        if (block.timestamp < cliffTime) {
            return 0;
        }

        uint256 endTime = uint256(schedule.start) + uint256(schedule.duration);
        if (block.timestamp >= endTime) {
            return schedule.totalAmount;
        }

        uint256 elapsed = block.timestamp - uint256(schedule.start);
        return (schedule.totalAmount * elapsed) / uint256(schedule.duration);
    }
}