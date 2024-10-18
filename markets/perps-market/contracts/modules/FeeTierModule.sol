//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

import "../storage/FeeTier.sol";
import "../interfaces/IFeeTierModule.sol";
import "@synthetixio/core-contracts/contracts/ownership/OwnableStorage.sol";

contract FeeTierModule is IFeeTierModule {
    /**
     * @inheritdoc IFeeTierModule
     */
    function setFeeTier(
        uint256 id,
        uint256 makerDiscount,
        uint256 takerDiscount
    ) external override {
        OwnableStorage.onlyOwner();

        if (id == 0) revert InvalidFeeTierId();

        FeeTier.Data storage feeTier = FeeTier.load(id);
        FeeTier.setFeeTier(feeTier, makerDiscount, takerDiscount);

        emit FeeTierSet(id, makerDiscount, takerDiscount);
    }

    /**
     * @inheritdoc IFeeTierModule
     */
    function getFeeTier(uint256 id) external view override returns (uint256, uint256) {
        FeeTier.Data storage feeTier = FeeTier.load(id);
        return (feeTier.makerDiscount, feeTier.takerDiscount);
    }
}
