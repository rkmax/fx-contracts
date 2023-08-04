//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

import {Account} from "@synthetixio/main/contracts/storage/Account.sol";
import {PerpMarketConfiguration} from "../storage/PerpMarketConfiguration.sol";
import {PerpMarket} from "../storage/PerpMarket.sol";
import {PerpCollateral} from "../storage/PerpCollateral.sol";
import {Position} from "../storage/Position.sol";
import "../interfaces/ILiquidationModule.sol";

contract LiquidationModule is ILiquidationModule {
    using PerpMarket for PerpMarket.Data;
    using Position for Position.Data;

    // --- Mutative --- //

    /**
     * @inheritdoc ILiquidationModule
     */
    function flagPosition(uint128 accountId, uint128 marketId) external {}

    /**
     * @inheritdoc ILiquidationModule
     */
    function liquidatePosition(uint128 accountId, uint128 marketId) external {}

    /**
     * @inheritdoc ILiquidationModule
     */
    function getLiquidationKeeperFee(uint128 accountId, uint128 marketId) external {}

    // --- Views --- //

    /**
     * @inheritdoc ILiquidationModule
     */
    function isPositionLiquidatable(uint128 accountId, uint128 marketId) external view returns (bool) {
        Account.exists(accountId);
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        return
            market.positions[accountId].isLiquidatable(
                PerpCollateral.getCollateralUsd(accountId, marketId),
                market.getOraclePrice(),
                PerpMarketConfiguration.load(marketId)
            );
    }

    /**
     * @inheritdoc ILiquidationModule
     */
    function getLiquidationMarginUsd(
        uint128 accountId,
        uint128 marketId
    ) external view returns (uint256 im, uint256 mm) {
        Account.exists(accountId);
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        PerpMarketConfiguration.Data storage marketConfig = PerpMarketConfiguration.load(marketId);
        (im, mm) = Position.getLiquidationMarginUsd(
            market.positions[accountId].size,
            market.getOraclePrice(),
            marketConfig
        );
    }

    /**
     * @inheritdoc ILiquidationModule
     */
    function getHealthRating(uint128 accountId, uint128 marketId) external view returns (uint256) {
        Account.exists(accountId);
        PerpMarket.Data storage market = PerpMarket.exists(marketId);
        return
            market.positions[accountId].getHealthRating(
                PerpCollateral.getCollateralUsd(accountId, marketId),
                market.getOraclePrice(),
                PerpMarketConfiguration.load(marketId)
            );
    }
}
