import assert from 'assert';
import assertBn from '@synthetixio/core-utils/utils/assertions/assert-bignumber';
import assertEvent from '@synthetixio/core-utils/utils/assertions/assert-event';
import assertRevert from '@synthetixio/core-utils/utils/assertions/assert-revert';
import { wei } from '@synthetixio/wei';
import { BigNumber, Signer, ethers, utils } from 'ethers';
import { shuffle, times } from 'lodash';
import forEach from 'mocha-each';
import { PerpCollateral, bootstrap } from '../../bootstrap';
import {
  bn,
  genBootstrap,
  genNumber,
  genOneOf,
  genOrder,
  genOrderFromSizeDelta,
  genSide,
  genTrader,
  toRoundRobinGenerators,
} from '../../generators';
import {
  depositMargin,
  commitAndSettle,
  commitOrder,
  setMarketConfigurationById,
  getBlockTimestamp,
  withExplicitEvmMine,
  findEventSafe,
  SYNTHETIX_USD_MARKET_ID,
  fastForwardBySec,
  extendContractAbi,
  BURN_ADDRESS,
  getSusdCollateral,
  isSusdCollateral,
  findOrThrow,
} from '../../helpers';
import { Market, Trader } from '../../typed';
import { assertEvents } from '../../assert';

describe('LiquidationModule', () => {
  const bs = bootstrap(genBootstrap());
  const {
    markets,
    collaterals,
    collateralsWithoutSusd,
    traders,
    keeper,
    keeper2,
    keeper3,
    endorsedKeeper,
    systems,
    provider,
    restore,
  } = bs;

  beforeEach(restore);

  describe('flagPosition', () => {
    it('should flag a position with a health factor <= 1', async () => {
      const { PerpMarketProxy } = systems();

      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });

      await commitAndSettle(bs, marketId, trader, order);

      // Price falls/rises between 10% should results in a healthFactor of < 1.
      //
      // Whether it goes up or down depends on the side of the order.
      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      const { healthFactor } = await PerpMarketProxy.getPositionDigest(trader.accountId, marketId);
      assertBn.lte(healthFactor, bn(1));

      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
        provider()
      );
      const keeperAddress = await keeper().getAddress();
      await assertEvent(
        receipt,
        `PositionFlaggedLiquidation(${trader.accountId}, ${marketId}, "${keeperAddress}", ${newMarketOraclePrice})`,
        PerpMarketProxy
      );
    });

    it('should remove any pending orders when present', async () => {
      const { PerpMarketProxy } = systems();

      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order1 = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order1);

      // Commit a new order but don't settle.
      const order2 = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 0.5,
        desiredSide: orderSide,
      });
      await commitOrder(bs, marketId, trader, order2);
      const commitmentTime = await getBlockTimestamp(provider());

      // Price moves 10% and results in a healthFactor of < 1.
      const newMarketOraclePrice = wei(order2.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
        provider()
      );
      const keeperAddress = await keeper().getAddress();
      await assertEvent(
        receipt,
        `PositionFlaggedLiquidation(${trader.accountId}, ${marketId}, "${keeperAddress}", ${newMarketOraclePrice})`,
        PerpMarketProxy
      );
      await assertEvent(receipt, `OrderCanceled(${trader.accountId}, ${marketId}, ${commitmentTime})`, PerpMarketProxy);
    });

    it('should sell all available synth collateral for sUSD when flagging', async () => {
      const { PerpMarketProxy } = systems();

      const collateral = genOneOf(collateralsWithoutSusd());
      const orderSide = genSide();
      const marginUsd = genOneOf([1000, 5000]);

      const { trader, market, marketId, collateralDepositAmount, marginUsdDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredCollateral: collateral, desiredMarginUsdDepositAmount: marginUsd })
      );

      const order1 = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order1);

      // Verify no USD but _some_ non-USD collateral was used as margin.
      const d1 = await PerpMarketProxy.getAccountDigest(trader.accountId, marketId);
      const collateralBalanceBefore = findOrThrow(d1.depositedCollaterals, (c) =>
        c.synthMarketId.eq(collateral.synthMarketId())
      ).available;
      const usdBalanceBefore = findOrThrow(d1.depositedCollaterals, (c) =>
        c.synthMarketId.eq(SYNTHETIX_USD_MARKET_ID)
      ).available;

      assertBn.equal(collateralBalanceBefore, collateralDepositAmount);
      assertBn.isZero(usdBalanceBefore);

      // Price moves 10% and results in a healthFactor of < 1.
      const newMarketOraclePrice = wei(order1.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      // Flag for liqudation, triggering the sale of collateral for sUSD.
      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

      // Assert the collateral has been sold and all that's left is sUSD (minus fees).
      const d2 = await PerpMarketProxy.getAccountDigest(trader.accountId, marketId);

      const collateralBalanceAfter = findOrThrow(d2.depositedCollaterals, (c) =>
        c.synthMarketId.eq(collateral.synthMarketId())
      ).available;
      const usdBalanceAfter = findOrThrow(d2.depositedCollaterals, (c) =>
        c.synthMarketId.eq(SYNTHETIX_USD_MARKET_ID)
      ).available;

      assertBn.isZero(collateralBalanceAfter);
      assertBn.near(usdBalanceAfter, marginUsdDepositAmount); // .near to account for spot-market skewFee.
    });

    it('should not sell any synth collateral when all collateral is already sUSD');

    forEach([
      ['sUSD', () => getSusdCollateral(collaterals())],
      ['non-sUSD', () => genOneOf(collateralsWithoutSusd())],
    ]).it('should emit all events in correct order (%s)', async (_, getCollateral: () => PerpCollateral) => {
      const { PerpMarketProxy, Core, SpotMarket } = systems();

      const orderSide = genSide();
      const { trader, market, marketId, collateralDepositAmount, marginUsdDepositAmount, collateral, collateralPrice } =
        await depositMargin(bs, genTrader(bs, { desiredCollateral: getCollateral() }));

      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      // Price falls/rises between 10% should results in a healthFactor of < 1.
      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      const { healthFactor } = await PerpMarketProxy.getPositionDigest(trader.accountId, marketId);
      assertBn.lte(healthFactor, bn(1));

      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
        provider()
      );

      const keeperAddress = await keeper().getAddress();

      // Create a contract that can parse all events emitted.
      //
      // This isn't necessary for sUSD collateral but it doesn't affect the correctness of this test.
      const spotMarketEvents = SpotMarket.interface.format(utils.FormatTypes.full);
      const contractsWithAllEvents = extendContractAbi(
        PerpMarketProxy,
        Core.interface
          .format(utils.FormatTypes.full)
          .concat(spotMarketEvents)
          .concat(['event Transfer(address indexed from, address indexed to, uint256 value)'])
      );

      let expectedEvents: string[] = [
        `PositionFlaggedLiquidation(${trader.accountId}, ${marketId}, "${keeperAddress}", ${newMarketOraclePrice})`,
      ];

      if (!isSusdCollateral(collateral)) {
        // It's quite hard to calculate the skew fee from selling our collateral, so we cheat a little grab it from the event
        const usdAmountAfterSpotSell = findEventSafe(receipt, 'SynthSold', contractsWithAllEvents)?.args
          .amountReturned as BigNumber;

        // Assert that it's slightly smaller (or equal depending on skew scale) than the deposited amount
        assertBn.lte(usdAmountAfterSpotSell, marginUsdDepositAmount);

        // Some variables for readability.
        const spotMarketFees = `[0, 0, 0, 0]`;
        const collectedFee = 0;
        const referrer = BURN_ADDRESS;
        const collateralAddress = collateral.synthAddress();
        const synthId = collateral.synthMarketId();

        expectedEvents = expectedEvents.concat([
          `Transfer("${Core.address}", "${PerpMarketProxy.address}", ${collateralDepositAmount})`,
          `MarketCollateralWithdrawn(${marketId}, "${collateralAddress}", ${collateralDepositAmount}, "${PerpMarketProxy.address}")`,
          `Transfer("${PerpMarketProxy.address}", "${BURN_ADDRESS}", ${collateralDepositAmount})`,
          `Transfer("${BURN_ADDRESS}", "${PerpMarketProxy.address}", ${usdAmountAfterSpotSell})`,
          `MarketUsdWithdrawn(${synthId}, "${PerpMarketProxy.address}", ${usdAmountAfterSpotSell}, "${SpotMarket.address}")`,
          `SynthSold(${synthId}, ${usdAmountAfterSpotSell}, ${spotMarketFees}, ${collectedFee}, "${referrer}", ${collateralPrice})`,
          `Transfer("${PerpMarketProxy.address}", "${BURN_ADDRESS}", ${usdAmountAfterSpotSell})`,
          `MarketUsdDeposited(${marketId}, "${PerpMarketProxy.address}", ${usdAmountAfterSpotSell}, "${PerpMarketProxy.address}")`,
        ]);
      }

      await assertEvents(receipt, expectedEvents, contractsWithAllEvents);
    });

    it('should revert when position already flagged', async () => {
      const { PerpMarketProxy } = systems();

      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });

      await commitAndSettle(bs, marketId, trader, order);

      await market.aggregator().mockSetCurrentPrice(
        wei(order.oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );

      // First flag should be successful.
      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

      // Second flag should fail because already flagged.
      await assertRevert(
        PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
        `PositionFlagged()`,
        PerpMarketProxy
      );
    });

    it('should revert when position health factor > 1', async () => {
      const { PerpMarketProxy } = systems();

      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });

      await commitAndSettle(bs, marketId, trader, order);

      // Position just opened and cannot be liquidated.
      await assertRevert(
        PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
        `CannotLiquidatePosition()`,
        PerpMarketProxy
      );
    });

    it('should revert when no open position', async () => {
      const { PerpMarketProxy } = systems();
      const { trader, marketId } = await depositMargin(bs, genTrader(bs));

      // Position just opened and cannot be liquidated.
      await assertRevert(
        PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
        `PositionNotFound()`,
        PerpMarketProxy
      );
    });

    it('should revert when accountId does not exist', async () => {
      const { PerpMarketProxy } = systems();

      const { marketId } = await depositMargin(bs, genTrader(bs));
      const invalidAccountId = 42069;

      await assertRevert(
        PerpMarketProxy.connect(keeper()).flagPosition(invalidAccountId, marketId),
        `PositionNotFound()`,
        PerpMarketProxy
      );
    });

    it('should revert when marketId does not exist', async () => {
      const { PerpMarketProxy } = systems();

      const { trader } = await depositMargin(bs, genTrader(bs));
      const invalidMarketId = 42069;

      await assertRevert(
        PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, invalidMarketId),
        `MarketNotFound("${invalidMarketId}")`,
        PerpMarketProxy
      );
    });
  });

  describe('liquidatePosition', () => {
    const commtAndSettleLiquidatedPosition = async (desiredKeeper: ethers.Signer) => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation, flag for liquidation. Additionally, we set
      // `desiredMarginUsdDepositAmount` to a low~ish value to prevent partial liquidations.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      // Set a large enough liqCap to ensure a full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      await PerpMarketProxy.connect(desiredKeeper).flagPosition(trader.accountId, marketId);

      // Attempt the liquidate. This should complete successfully.
      const { tx, receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(desiredKeeper).liquidatePosition(trader.accountId, marketId),
        provider()
      );

      return { tx, receipt, trader, marketId, newMarketOraclePrice };
    };

    it('should fully liquidate a flagged position', async () => {
      const { PerpMarketProxy } = systems();

      const desiredKeeper = keeper();
      const keeperAddress = await desiredKeeper.getAddress();

      const { tx, receipt, trader, marketId, newMarketOraclePrice } = await commtAndSettleLiquidatedPosition(
        desiredKeeper
      );

      const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);
      const positionLiquidatedEventProperties = [
        trader.accountId,
        marketId,
        0, // sizeRemaining (expected full liquidation).
        `"${keeperAddress}"`, // keeper
        `"${keeperAddress}"`, // flagger
        positionLiquidatedEvent?.args.liqReward,
        positionLiquidatedEvent?.args.keeperFee,
        newMarketOraclePrice,
      ].join(', ');

      await assertEvent(tx, `PositionLiquidated(${positionLiquidatedEventProperties})`, PerpMarketProxy);
    });

    it('should liquidate a flagged position even if health > 1', async () => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation, flag for liquidation. Additionally, set
      // `desiredMarginUsdDepositAmount` to a low~ish value to prevent partial liquidations.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      const marketOraclePrice = order.oraclePrice;
      await market.aggregator().mockSetCurrentPrice(
        wei(marketOraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );

      const { healthFactor: hf1 } = await PerpMarketProxy.getPositionDigest(trader.accountId, marketId);
      assertBn.lt(hf1, bn(1));
      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

      // Price moves back and they're no longer in liquidation but already flagged.
      await market.aggregator().mockSetCurrentPrice(marketOraclePrice);
      const { healthFactor: hf2 } = await PerpMarketProxy.getPositionDigest(trader.accountId, marketId);
      assertBn.gt(hf2, bn(1));

      // Attempt the liquidate. This should complete successfully.
      const { tx, receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId),
        provider()
      );
      const keeperAddress = await keeper().getAddress();

      const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);
      const positionLiquidatedEventProperties = [
        trader.accountId,
        marketId,
        0, // sizeRemaining (expected full liquidation).
        `"${keeperAddress}"`, // keeper
        `"${keeperAddress}"`, // flagger
        positionLiquidatedEvent?.args.liqReward,
        positionLiquidatedEvent?.args.keeperFee,
        marketOraclePrice,
      ].join(', ');

      await assertEvent(tx, `PositionLiquidated(${positionLiquidatedEventProperties})`, PerpMarketProxy);
    });

    it('should update market size and skew upon full liquidation', async () => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation, flag for liquidation.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      // Set a large enough cap to ensure we always get full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      await market.aggregator().mockSetCurrentPrice(
        wei(order.oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );
      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

      const d1 = await PerpMarketProxy.getMarketDigest(marketId);

      // Attempt the liquidate. This should complete successfully.
      await PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId);

      const d2 = await PerpMarketProxy.getMarketDigest(marketId);

      assertBn.lt(d2.size, d1.size);
      assertBn.lt(d2.skew.abs(), d1.skew.abs());
      assertBn.isZero(d2.size);
      assertBn.isZero(d2.skew);
    });

    it('should update lastLiq{time,utilization}', async () => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation, flag for liquidation.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      await market.aggregator().mockSetCurrentPrice(
        wei(order.oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );
      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

      const d1 = await PerpMarketProxy.getMarketDigest(marketId);

      // Attempt the liquidate. This should complete successfully.
      await PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId);

      const d2 = await PerpMarketProxy.getMarketDigest(marketId);

      assertBn.gt(d2.lastLiquidationTime, d1.lastLiquidationTime);
      assertBn.lt(d2.remainingLiquidatableSizeCapacity, d1.remainingLiquidatableSizeCapacity);
    });

    it('should send liqReward to flagger and keeperFee to liquidator', async () => {
      const { PerpMarketProxy, USD } = systems();

      const settlementKeeper = keeper();
      const flaggerKeeper = keeper2();
      const liquidatorKeeper = keeper3();

      // Commit, settle, place position into liquidation, flag for liquidation. Additionally, set
      // `desiredMarginUsdDepositAmount` to a low~ish value to prevent partial liquidations.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order, { desiredKeeper: settlementKeeper });

      // Set a large enough liqCap to ensure a full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader.accountId, marketId);

      // Attempt the liquidate. This should complete successfully.
      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(liquidatorKeeper).liquidatePosition(trader.accountId, marketId),
        provider()
      );

      const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);
      const liqReward = positionLiquidatedEvent?.args.liqReward as BigNumber;
      const keeperFee = positionLiquidatedEvent?.args.keeperFee as BigNumber;

      assertBn.equal(await USD.balanceOf(await flaggerKeeper.getAddress()), liqReward);
      assertBn.equal(await USD.balanceOf(await liquidatorKeeper.getAddress()), keeperFee);
    });

    it('should send send both fees to flagger if same keeper', async () => {
      const { PerpMarketProxy, USD } = systems();

      const settlementKeeper = keeper();
      const flaggerKeeper = keeper2();

      // Commit, settle, place position into liquidation, flag for liquidation. Additionally, set
      // `desiredMarginUsdDepositAmount` to a low~ish value to prevent partial liquidations.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order, { desiredKeeper: settlementKeeper });

      // Set a large enough liqCap to ensure a full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader.accountId, marketId);

      // Attempt the liquidate. This should complete successfully.
      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(flaggerKeeper).liquidatePosition(trader.accountId, marketId),
        provider()
      );

      const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);
      const liqReward = positionLiquidatedEvent?.args.liqReward as BigNumber;
      const keeperFee = positionLiquidatedEvent?.args.keeperFee as BigNumber;
      const expectedKeeperUsdBalance = liqReward.add(keeperFee);

      assertBn.equal(await USD.balanceOf(await flaggerKeeper.getAddress()), expectedKeeperUsdBalance);
    });

    it('should not send endorsed keeper any liquidation rewards when flagger', async () => {
      const { PerpMarketProxy, USD } = systems();

      const settlementKeeper = keeper();
      const flaggerKeeper = endorsedKeeper();
      const liquidatorKeeper = keeper2();

      // Commit, settle, place position into liquidation, flag for liquidation. Additionally, set
      // `desiredMarginUsdDepositAmount` to a low~ish value to prevent partial liquidations.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order, { desiredKeeper: settlementKeeper });

      // Set a large enough liqCap to ensure a full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader.accountId, marketId);

      // Attempt the liquidate. This should complete successfully.
      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(liquidatorKeeper).liquidatePosition(trader.accountId, marketId),
        provider()
      );

      const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);
      const keeperFee = positionLiquidatedEvent?.args.keeperFee as BigNumber;

      // Expect the flagger to receive _nothing_ and liquidator to receive just the keeperFee.
      assertBn.isZero(await USD.balanceOf(await flaggerKeeper.getAddress()));
      assertBn.equal(await USD.balanceOf(await liquidatorKeeper.getAddress()), keeperFee);
    });

    it('should not send endorsed keeper liqReward when they are both flagger and liquidator', async () => {
      const { PerpMarketProxy, USD } = systems();

      const settlementKeeper = keeper();
      const flaggerKeeper = endorsedKeeper();

      // Commit, settle, place position into liquidation, flag for liquidation. Additionally, set
      // `desiredMarginUsdDepositAmount` to a low~ish value to prevent partial liquidations.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order, { desiredKeeper: settlementKeeper });

      // Set a large enough liqCap to ensure a full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader.accountId, marketId);

      // Attempt the liquidate. This should complete successfully.
      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(flaggerKeeper).liquidatePosition(trader.accountId, marketId),
        provider()
      );

      const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);
      const keeperFee = positionLiquidatedEvent?.args.keeperFee as BigNumber;

      // Only receive keeperFee, no liqReward should be sent.
      assertBn.equal(await USD.balanceOf(await flaggerKeeper.getAddress()), keeperFee);
    });

    it('should remove flagger on full liquidation', async () => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation, flag for liquidation, liquidate.
      const orderSide = genSide();
      const trader = genOneOf(traders());
      const market = genOneOf(markets());
      const marketId = market.marketId();
      const collateral = genOneOf(collaterals());

      // Set a large enough liqCap to ensure a full liquidation.
      await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(100) });

      const gTrader1 = await depositMargin(
        bs,
        genTrader(bs, { desiredTrader: trader, desiredMarket: market, desiredCollateral: collateral })
      );
      const order1 = await genOrder(bs, market, collateral, gTrader1.collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order1);

      const { answer: marketOraclePrice1 } = await market.aggregator().latestRoundData();
      await market.aggregator().mockSetCurrentPrice(
        wei(marketOraclePrice1)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );
      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);
      await PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId);

      const gTrader2 = await depositMargin(
        bs,
        genTrader(bs, { desiredTrader: trader, desiredMarket: market, desiredCollateral: collateral })
      );
      const order2 = await genOrder(bs, market, collateral, gTrader2.collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order2);

      const { answer: marketOraclePrice2 } = await market.aggregator().latestRoundData();
      await market.aggregator().mockSetCurrentPrice(
        wei(marketOraclePrice2)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );

      // Liquidation should fail because the flagger was previously removed for this trader.
      await assertRevert(
        PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId),
        `PositionNotFlagged()`,
        PerpMarketProxy
      );
    });

    it('should remove all position collateral from market on liquidation', async () => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation, flag for liquidation. For the purposes
      // of this test, ensure we can liquidate the entire position in one call (hence the smaller
      // marginUsd deposit amounts).
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(
        bs,
        genTrader(bs, { desiredMarginUsdDepositAmount: genOneOf([1000, 3000, 5000]) })
      );
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      const d1 = await PerpMarketProxy.getPositionDigest(trader.accountId, marketId);

      const newMarketOraclePrice = wei(order.oraclePrice)
        .mul(orderSide === 1 ? 0.9 : 1.1)
        .toBN();
      await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);
      await PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId);

      const d2 = await PerpMarketProxy.getPositionDigest(trader.accountId, marketId);
      const { collateralUsd } = await PerpMarketProxy.getAccountDigest(trader.accountId, marketId);

      assertBn.gt(d1.remainingMarginUsd, d2.remainingMarginUsd);
      assertBn.isZero(d2.remainingMarginUsd);
      assertBn.isZero(collateralUsd);
    });

    it('should remove all market deposited collateral after full liquidation', async () => {
      const { PerpMarketProxy } = systems();

      const { marketId } = await commtAndSettleLiquidatedPosition(keeper());

      // Expecting ZERO collateral deposited into the market.
      const d1 = await PerpMarketProxy.getMarketDigest(marketId);
      d1.depositedCollaterals.map((c) => assertBn.isZero(c.available));
    });

    it('should remove all account margin collateral after full liquidation', async () => {
      const { PerpMarketProxy } = systems();

      const { trader, marketId } = await commtAndSettleLiquidatedPosition(keeper());

      // Expecting ZERO collateral left associated with the account.
      const d = await PerpMarketProxy.getAccountDigest(trader.accountId, marketId);
      assertBn.isZero(d.collateralUsd);
      d.depositedCollaterals.forEach((c) => assertBn.isZero(c.available));
    });

    it('should emit all events in correct order');

    it('should recompute funding', async () => {
      const { PerpMarketProxy } = systems();

      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });

      await commitAndSettle(bs, marketId, trader, order);

      // Price falls/rises between 10% should results in a healthFactor of < 1.
      //
      // Whether it goes up or down depends on the side of the order.
      await market.aggregator().mockSetCurrentPrice(
        wei(order.oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );

      await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

      const { receipt } = await withExplicitEvmMine(
        () => PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId),
        provider()
      );
      await assertEvent(receipt, `FundingRecomputed`, PerpMarketProxy);
    });

    it('should revert when position is not flagged', async () => {
      const { PerpMarketProxy } = systems();

      // Commit, settle, place position into liquidation.
      const orderSide = genSide();
      const { trader, market, marketId, collateral, collateralDepositAmount } = await depositMargin(bs, genTrader(bs));
      const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
        desiredLeverage: 10,
        desiredSide: orderSide,
      });
      await commitAndSettle(bs, marketId, trader, order);

      await market.aggregator().mockSetCurrentPrice(
        wei(order.oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN()
      );

      // Attempt the liquidate. Not flagged, should not liquidate.
      await assertRevert(
        PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId),
        `PositionNotFlagged()`,
        PerpMarketProxy
      );
    });

    it('should revert when no open position or already liquidated', async () => {
      const { PerpMarketProxy } = systems();
      const { trader, marketId } = await genTrader(bs);
      await assertRevert(
        PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId),
        `PositionNotFound()`,
        PerpMarketProxy
      );
    });

    it('should revert when accountId does not exist', async () => {
      const { PerpMarketProxy } = systems();

      const { marketId } = await depositMargin(bs, genTrader(bs));
      const invalidAccountId = 42069;

      await assertRevert(
        PerpMarketProxy.connect(keeper()).liquidatePosition(invalidAccountId, marketId),
        `AccountNotFound("${invalidAccountId}")`,
        PerpMarketProxy
      );
    });

    it('should revert when marketId does not exist', async () => {
      const { PerpMarketProxy } = systems();

      const { trader } = await depositMargin(bs, genTrader(bs));
      const invalidMarketId = 42069;

      await assertRevert(
        PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, invalidMarketId),
        `MarketNotFound("${invalidMarketId}")`,
        PerpMarketProxy
      );
    });

    describe('getRemainingLiquidatableSizeCapacity', () => {
      const calcMaxLiquidatableCapacity = (
        makerFee: BigNumber,
        takerFee: BigNumber,
        skewScale: BigNumber,
        liquidationLimitScalar: BigNumber
      ) => wei(makerFee.add(takerFee)).mul(skewScale).mul(liquidationLimitScalar).toBN();

      describe('maxLiquidatableCapacity', () => {
        it('should be calculated relative to makerFee/takerFee and skewScale', async () => {
          const { PerpMarketProxy } = systems();
          const market = genOneOf(markets());
          const marketId = market.marketId();

          const liquidationLimitScalar = bn(1);
          const makerFee = bn(0.0001);
          const takerFee = bn(0.0001);
          const skewScale = bn(1_000_000);

          await setMarketConfigurationById(bs, marketId, {
            liquidationLimitScalar,
            makerFee,
            takerFee,
            skewScale,
          });

          const { maxLiquidatableCapacity } = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
          const expectedMaxLiquidatableCapacity = calcMaxLiquidatableCapacity(
            makerFee,
            takerFee,
            skewScale,
            liquidationLimitScalar
          );
          assertBn.equal(maxLiquidatableCapacity, expectedMaxLiquidatableCapacity);
        });

        /* Randomly test 10 scalars between 0 and 1 (inclusive, always include boundaries). */
        forEach([0, ...times(8).map(() => genNumber(0.1, 0.9)), 1]).it(
          `should scale with liquidationLimitScalar of '%0.5f'`,
          async (scalar: number) => {
            const { PerpMarketProxy } = systems();
            const market = genOneOf(markets());
            const marketId = market.marketId();

            const makerFee = bn(genNumber(0.0001, 0.0005));
            const takerFee = bn(genNumber(0.0006, 0.001));
            const skewScale = bn(1_000_000);

            const liquidationLimitScalar = bn(scalar);
            await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar, makerFee, takerFee, skewScale });

            const { maxLiquidatableCapacity } = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
            const expectedMaxLiquidatableCapacity = calcMaxLiquidatableCapacity(
              makerFee,
              takerFee,
              skewScale,
              liquidationLimitScalar
            );
            assertBn.equal(maxLiquidatableCapacity, expectedMaxLiquidatableCapacity);
          }
        );
      });

      describe('remainingCapacity', () => {
        it('should be updated to reflect a recent liquidation');

        it('should be zero when cap has been met and an endorsed liquidator pushes past cap for window');
      });
    });

    describe('{partialLiqudation,liquidationCapacity,liqReward}', () => {
      const configurePartiallyLiquidatedPosition = async (
        desiredFlagger?: Signer,
        desiredLiquidator?: Signer,
        desiredTrader?: Trader,
        desiredMarket?: Market,
        desiredMarginUsdDepositAmount: number = 50_000
      ) => {
        const { PerpMarketProxy } = systems();

        const flaggerKeeper = desiredFlagger ?? keeper();
        const liquidationKeeper = desiredLiquidator ?? keeper();

        const flaggerKeeperAddr = await flaggerKeeper.getAddress();
        const liquidationKeeperAddr = await liquidationKeeper.getAddress();

        // Be quite explicit with what market and market params we are using to ensure a partial liquidation.
        const market = desiredMarket ?? markets()[0];
        await market.aggregator().mockSetCurrentPrice(bn(25_000));
        const orderSide = genSide();

        const { trader, marketId, collateral, collateralDepositAmount } = await depositMargin(
          bs,
          genTrader(bs, { desiredTrader, desiredMarket: market, desiredMarginUsdDepositAmount })
        );
        const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
          desiredLeverage: 10,
          desiredSide: orderSide,
        });
        await commitAndSettle(bs, marketId, trader, order);

        // Reconfigure market to lower the remainingCapacity such that it's < collateralDepositAmount but > 0.
        //
        // This effectively gives us a liquidation max cap at 1.
        await setMarketConfigurationById(bs, marketId, {
          liquidationLimitScalar: bn(0.01),
          makerFee: bn(0.0001),
          takerFee: bn(0.0001),
          skewScale: bn(500_000),
        });

        const capBefore = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.gt(capBefore.remainingCapacity, 0);
        assertBn.lt(capBefore.remainingCapacity, collateralDepositAmount);

        // Price moves 10% and results in a healthFactor of < 1.
        const newMarketOraclePrice = wei(order.oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN();
        await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

        await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader.accountId, marketId);

        // Attempt the liquidate. This should complete successfully.
        const { tx, receipt } = await withExplicitEvmMine(
          () => PerpMarketProxy.connect(liquidationKeeper).liquidatePosition(trader.accountId, marketId),
          provider()
        );

        const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);

        const remainingSize = order.sizeDelta.abs().sub(capBefore.remainingCapacity).mul(orderSide);
        const positionLiquidatedEventProperties = [
          trader.accountId,
          marketId,
          remainingSize,
          `"${flaggerKeeperAddr}"`,
          `"${liquidationKeeperAddr}"`,
          positionLiquidatedEvent?.args.liqReward,
          positionLiquidatedEvent?.args.keeperFee,
          newMarketOraclePrice,
        ].join(', ');
        await assertEvent(receipt, `PositionLiquidated(${positionLiquidatedEventProperties})`, PerpMarketProxy);

        const capAfter = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(capAfter.remainingCapacity);

        return {
          tx,
          receipt,
          marketId,
          market,
          order,
          orderSide,
          liquidatedSize: capBefore.remainingCapacity,
          remainingSize,
          trader,
          flaggerKeeper,
          liquidationKeeper,
        };
      };

      it('should partially liquidate and exhaust cap if position hits liq window cap', async () => {
        const { PerpMarketProxy } = systems();

        const { marketId } = await configurePartiallyLiquidatedPosition();
        const cap = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);

        assertBn.isZero(cap.remainingCapacity);
      });

      it('should partially update market skew/size when partially liquidated', async () => {
        const { PerpMarketProxy } = systems();

        const { remainingSize, marketId } = await configurePartiallyLiquidatedPosition();
        const d1 = await PerpMarketProxy.getMarketDigest(marketId);

        assertBn.equal(d1.size, remainingSize.abs());
        assertBn.equal(d1.skew, remainingSize);
      });

      it('should allow an endorsed keeper to fully liquidate a position even if above caps', async () => {
        const { PerpMarketProxy } = systems();

        const { trader, remainingSize, marketId } = await configurePartiallyLiquidatedPosition();

        // Should be fullt exhausted.
        const cap1 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(cap1.remainingCapacity);

        // Endorsed liqudaitor to liquidate remaining capacity.
        const d1 = await PerpMarketProxy.getAccountDigest(trader.accountId, marketId);
        assertBn.equal(d1.position.size, remainingSize);

        await withExplicitEvmMine(
          () => PerpMarketProxy.connect(endorsedKeeper()).liquidatePosition(trader.accountId, marketId),
          provider()
        );

        const d2 = await PerpMarketProxy.getAccountDigest(trader.accountId, marketId);
        assertBn.isZero(d2.position.size);

        const cap2 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(cap2.remainingCapacity);
      });

      it('should allow further liquidations even if exceed caps when pd is below maxPd', async () => {
        const { PerpMarketProxy } = systems();

        const tradersGenerator = toRoundRobinGenerators(shuffle(traders()));
        const trader1 = tradersGenerator.next().value;
        const trader2 = tradersGenerator.next().value;
        const desiredMarginUsdDepositAmount = 50_000;

        const desiredKeeper = keeper();
        const desiredKeeperAddress = await desiredKeeper.getAddress();
        const {
          liquidatedSize,
          marketId,
          market,
          order: order1,
          orderSide: orderSide1,
        } = await configurePartiallyLiquidatedPosition(
          desiredKeeper,
          desiredKeeper,
          trader1,
          undefined,
          desiredMarginUsdDepositAmount
        );

        // Partially liquidated position.
        const cap = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(cap.remainingCapacity);

        // Open another position with the same to balance skew.
        await depositMargin(
          bs,
          genTrader(bs, {
            desiredTrader: trader2,
            desiredMarket: market,
            desiredMarginUsdDepositAmount,
          })
        );

        // Inverted side to neutralize skew.
        const desiredOrderSize = liquidatedSize.mul(orderSide1 === 1 ? -1 : 1);
        const order = await genOrderFromSizeDelta(bs, market, desiredOrderSize);
        await commitAndSettle(bs, marketId, trader2, order);

        // Liquidate remaining size.
        const { tx, receipt } = await withExplicitEvmMine(
          () => PerpMarketProxy.connect(keeper()).liquidatePosition(trader1.accountId, marketId),
          provider()
        );

        const positionLiquidatedEvent = findEventSafe(receipt, 'PositionLiquidated', PerpMarketProxy);

        // Partial liquidation (again) - not high enough cap to fully liquidate but did bypass liquidations.
        //
        // NOTE: We .mul(2) here because the position has been partially liquidated _twice_.
        const expectedRemainingSize = order1.sizeDelta.abs().sub(liquidatedSize.mul(2)).mul(orderSide1);
        const positionLiquidatedEventProperties = [
          trader1.accountId,
          marketId,
          expectedRemainingSize, // Remaining size to liquidate (none = dead).
          `"${desiredKeeperAddress}"`,
          `"${desiredKeeperAddress}"`,
          positionLiquidatedEvent?.args.liqReward,
          positionLiquidatedEvent?.args.keeperFee,
          order.oraclePrice,
        ].join(', ');

        await assertEvent(tx, `PositionLiquidated(${positionLiquidatedEventProperties})`, PerpMarketProxy);
      });

      it('should reset caps after window timeframe has elapsed', async () => {
        const { PerpMarketProxy } = systems();

        const { marketId } = await configurePartiallyLiquidatedPosition();

        // NOTE: We make an assumption about the configured liquidationWindowDuration.
        //
        // We know that this value is defined as 30s. If this changes then this test will most likely
        // break and this comment will be served as a notice.
        const { liquidationWindowDuration } = await PerpMarketProxy.getMarketConfigurationById(marketId);

        // Caps before moving time forward.
        const cap1 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(cap1.remainingCapacity);

        await fastForwardBySec(provider(), 15); // Half way into cap.

        const cap2 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(cap2.remainingCapacity);

        await fastForwardBySec(provider(), 14); // One second before end of cap.

        const cap3 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(cap3.remainingCapacity);

        await fastForwardBySec(provider(), 1); // Exact 30s.

        const cap4 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.equal(cap4.remainingCapacity, cap4.maxLiquidatableCapacity);

        await fastForwardBySec(provider(), 5); // 5s into new window.

        const cap5 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.equal(cap5.remainingCapacity, cap5.maxLiquidatableCapacity);

        await fastForwardBySec(provider(), liquidationWindowDuration.toNumber()); // > window over.

        const cap6 = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.equal(cap6.remainingCapacity, cap6.maxLiquidatableCapacity);
      });

      it('should pay out liquidation reward to flagger in chunks added up to total', async () => {
        const { PerpMarketProxy } = systems();

        const marketOraclePrice1 = bn(10_000);
        const market = markets()[0];
        const collateral = getSusdCollateral(collaterals());
        await market.aggregator().mockSetCurrentPrice(marketOraclePrice1);

        // Open a decently large position that would result in a partial liquiadtion.
        const { trader, marketId, collateralDepositAmount } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredMarket: market,
            desiredMarginUsdDepositAmount: 100_000,
            desiredCollateral: collateral,
          })
        );
        const order = await genOrder(bs, market, collateral, collateralDepositAmount, {
          desiredLeverage: 10,
          desiredSide: 1,
          desiredKeeperFeeBufferUsd: 0,
        });
        await commitAndSettle(bs, marketId, trader, order);

        // Reconfigure market to lower the remainingCapacity such that it's < collateralDepositAmount but > 0.
        //
        // This effectively gives us a liquidation max cap at 1.
        const liquidationRewardPercent = bn(0.1);
        await setMarketConfigurationById(bs, marketId, {
          liquidationLimitScalar: bn(0.01),
          makerFee: bn(0.0001),
          takerFee: bn(0.0001),
          skewScale: bn(500_000),
          liquidationRewardPercent,
        });

        const capBefore = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.gt(capBefore.remainingCapacity, 0);
        assertBn.lt(capBefore.remainingCapacity, collateralDepositAmount);

        // Price moves 10% and results in a healthFactor of < 1.
        //
        // 10k -> 9k
        const marketOraclePrice2 = wei(marketOraclePrice1).mul(0.9).toBN();
        await market.aggregator().mockSetCurrentPrice(marketOraclePrice2);

        // Expect liquidation reward to be 10% of the notional value.
        //
        // (100 * 9000) * 0.1 = 90k
        const { liqReward: totalLiqRewards } = await PerpMarketProxy.getLiquidationFees(trader.accountId, marketId);
        assertBn.equal(
          wei(order.sizeDelta).mul(marketOraclePrice2).mul(liquidationRewardPercent).toBN(),
          totalLiqRewards
        );

        // Dead.
        await PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId);

        let accLiqRewards = bn(0);
        let remainingSize = bn(-1);

        // Perform enough partial liquidations until fully liquidated.
        while (!remainingSize.isZero()) {
          const { receipt } = await withExplicitEvmMine(
            () => PerpMarketProxy.connect(keeper()).liquidatePosition(trader.accountId, marketId),
            provider()
          );
          const { liqReward: _liqReward, remainingSize: _remSize } = findEventSafe(
            receipt,
            'PositionLiquidated',
            PerpMarketProxy
          )?.args;
          accLiqRewards = accLiqRewards.add(_liqReward);
          remainingSize = _remSize;
        }

        // `sum(liqReward)` should equal to liqReward from the prior step.
        assertBn.equal(accLiqRewards, totalLiqRewards);
      });

      it('should cap liqReward to the maxKeeperFee');

      it('should cap liqreward to the minKeeperFee');

      it('should result in a higher liqReward if market price moves in favour of position');

      it('should result in a lower liqReward if market moves unfavourably of position');

      it('should use up cap (partial) before exceeding if pd < maxPd');

      it('should track and include endorsed keeper activity (cap + time) on liquidations', async () => {
        const { PerpMarketProxy } = systems();

        // Use the endorsed keeper to liquidate.
        const keeper = endorsedKeeper();
        const market = markets()[0];
        const marketId = market.marketId();

        const d1 = await PerpMarketProxy.getMarketDigest(marketId);

        await configurePartiallyLiquidatedPosition(keeper, keeper, undefined, market);

        const d2 = await PerpMarketProxy.getMarketDigest(marketId);

        // Last liquidation time is the current block (i.e. the time the position was liquidated).
        assertBn.isZero(d1.lastLiquidationTime);
        assertBn.equal((await provider().getBlock('latest')).timestamp, d2.lastLiquidationTime);

        // Ensure the capacity is also updated to reflect the liquidation.
        assertBn.gt(d1.remainingLiquidatableSizeCapacity, d2.remainingLiquidatableSizeCapacity);
      });

      it('should not remove flagger on partial liquidation', async () => {
        const { PerpMarketProxy } = systems();

        const { trader, marketId } = await configurePartiallyLiquidatedPosition();

        // Partially liquidated and should still remain flagged. A re-flat should not be allowed.
        await assertRevert(
          PerpMarketProxy.connect(keeper()).flagPosition(trader.accountId, marketId),
          `PositionFlagged()`,
          PerpMarketProxy
        );
      });

      it('should accumulate liq utilisation without exceeding cap', async () => {
        const { PerpMarketProxy } = systems();

        const flaggerKeeper = keeper();
        const liquidationKeeper = keeper2();

        // Ensure we use the same side and market for all traders.
        const orderSide = genSide();
        const market = genOneOf(markets());
        const marketId = market.marketId();

        // Set a fairly large liquidation limit scalar to prevent partial liquidations. Also give a large enough
        // window to ensure liquidations all occur within one window.
        await setMarketConfigurationById(bs, marketId, {
          liquidationLimitScalar: bn(10),
          liquidationWindowDuration: 60,
        });

        const orders: Awaited<ReturnType<typeof genOrder>>[] = [];

        // For every available trader, open a position (all on the same side) and liquidate everything. The
        // sum of all sizeDelta should be the utilisation and remaining should be max - utlisation.
        for (const trader of traders()) {
          const marginUsdDepositAmount = genOneOf([5000, 10_000, 15_000]);
          const collateral = genOneOf(collaterals());

          const { collateralDepositAmount: collateralDepositAmount1 } = await depositMargin(
            bs,
            genTrader(bs, {
              desiredTrader: trader,
              desiredCollateral: collateral,
              desiredMarket: market,
              desiredMarginUsdDepositAmount: marginUsdDepositAmount,
            })
          );
          const order = await genOrder(bs, market, collateral, collateralDepositAmount1, {
            desiredLeverage: 10,
            desiredSide: orderSide,
          });
          await commitAndSettle(bs, marketId, trader, order);

          orders.push(order);
        }

        const sizeToLiquidate = orders.reduce((acc, order) => acc.add(order.sizeDelta.abs()), bn(0));

        // Verify that liquidating both will not incur any caps.
        const capBefore = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.gt(capBefore.remainingCapacity, sizeToLiquidate);

        // Place both traders into liquidation.
        const oraclePrice = await PerpMarketProxy.getOraclePrice(marketId);
        const newMarketOraclePrice = wei(oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN();
        await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

        // Flag and liquidate it all.
        for (const trader of traders()) {
          await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader.accountId, marketId);
          await PerpMarketProxy.connect(liquidationKeeper).liquidatePosition(trader.accountId, marketId);
        }

        // Ensure both liquidations occurred on the same block.
        assertBn.isZero((await PerpMarketProxy.getMarketDigest(marketId)).size);

        // Ensure both were fully liquidated.
        const capAfter = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);

        // Ensure caps have not changed between liquidations.
        assertBn.equal(capBefore.maxLiquidatableCapacity, capAfter.maxLiquidatableCapacity);
        assertBn.equal(capAfter.remainingCapacity, capAfter.maxLiquidatableCapacity.sub(sizeToLiquidate));

        // Verify internal accounting tracks correct liquidation time and amount.
        const { remainingLiquidatableSizeCapacity } = await PerpMarketProxy.getMarketDigest(marketId);
        assertBn.equal(capAfter.maxLiquidatableCapacity.sub(remainingLiquidatableSizeCapacity), sizeToLiquidate);
      });

      it('should accumulate an into existing liquidation chunk if two tx in the same block', async () => {
        const { PerpMarketProxy } = systems();

        const flaggerKeeper = keeper();
        const liquidationKeeper = keeper2();

        const tradersGenerator = toRoundRobinGenerators(shuffle(traders()));
        const trader1 = tradersGenerator.next().value;
        const trader2 = tradersGenerator.next().value;

        const orderSide = genSide();
        const marginUsdDepositAmount = 15_000;
        const collateral = collaterals()[0]; // sUSD
        const market = markets()[0];
        const marketId = market.marketId();

        // Set a fairly large liquidation limit scalar to prevent partial liquidations.
        await setMarketConfigurationById(bs, marketId, { liquidationLimitScalar: bn(10) });

        // Trader 1.
        const { collateralDepositAmount: collateralDepositAmount1 } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredTrader: trader1,
            desiredCollateral: collateral,
            desiredMarket: market,
            desiredMarginUsdDepositAmount: marginUsdDepositAmount,
          })
        );
        const order1 = await genOrder(bs, market, collateral, collateralDepositAmount1, {
          desiredLeverage: 10,
          desiredSide: orderSide,
        });
        await commitAndSettle(bs, marketId, trader1, order1);

        // Trader 2.
        const { collateralDepositAmount: collateralDepositAmount2 } = await depositMargin(
          bs,
          genTrader(bs, {
            desiredTrader: trader2,
            desiredCollateral: collateral,
            desiredMarket: market,
            desiredMarginUsdDepositAmount: marginUsdDepositAmount,
          })
        );
        const order2 = await genOrder(bs, market, collateral, collateralDepositAmount2, {
          desiredLeverage: 10,
          desiredSide: orderSide,
        });
        await commitAndSettle(bs, marketId, trader2, order2);

        const sizeToLiquidate = order1.sizeDelta.abs().add(order2.sizeDelta.abs());

        // Verify that liquidating both will not incur any caps.
        const capBefore = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.gt(capBefore.remainingCapacity, sizeToLiquidate);

        // Place both traders into liquidation.
        const oraclePrice = order1.oraclePrice;
        const newMarketOraclePrice = wei(oraclePrice)
          .mul(orderSide === 1 ? 0.9 : 1.1)
          .toBN();
        await market.aggregator().mockSetCurrentPrice(newMarketOraclePrice);

        // Flag both users for liquidation.
        await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader1.accountId, marketId);
        await PerpMarketProxy.connect(flaggerKeeper).flagPosition(trader2.accountId, marketId);

        // Attempt to liquidate both in a single block.
        await provider().send('evm_setAutomine', [false]);

        const tx1 = await PerpMarketProxy.connect(liquidationKeeper).liquidatePosition(trader1.accountId, marketId);
        const tx2 = await PerpMarketProxy.connect(liquidationKeeper).liquidatePosition(trader2.accountId, marketId);

        await provider().send('evm_setAutomine', [true]);

        const receipt1 = await tx1.wait();
        const receipt2 = await tx2.wait();

        // Ensure both liquidations occurred on the same block.
        assert.equal(receipt1.blockNumber, receipt2.blockNumber);
        assert.equal(tx1.timestamp, tx2.timestamp);
        assertBn.isZero((await PerpMarketProxy.getMarketDigest(marketId)).size);

        // Ensure both were fully liquidated.
        const capAfter = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);

        // Ensure caps have not changed between liquidations.
        assertBn.equal(capBefore.maxLiquidatableCapacity, capAfter.maxLiquidatableCapacity);
        assertBn.equal(capAfter.remainingCapacity, capAfter.maxLiquidatableCapacity.sub(sizeToLiquidate));

        // Verify internal accounting tracks correct liquidation time and amount.
        const block = await provider().getBlock(receipt1.blockNumber);
        const { lastLiquidationTime, remainingLiquidatableSizeCapacity } = await PerpMarketProxy.getMarketDigest(
          marketId
        );
        assertBn.equal(lastLiquidationTime, block.timestamp);
        assertBn.equal(capAfter.maxLiquidatableCapacity.sub(remainingLiquidatableSizeCapacity), sizeToLiquidate);
      });

      it('should revert when liq cap has been met and not endorsed', async () => {
        const { PerpMarketProxy } = systems();

        const desiredKeeper = keeper(); // NOT endorsed.
        const { trader, marketId } = await configurePartiallyLiquidatedPosition(desiredKeeper, desiredKeeper);

        // Confirm we have exhausted caps.
        const { remainingCapacity } = await PerpMarketProxy.getRemainingLiquidatableSizeCapacity(marketId);
        assertBn.isZero(remainingCapacity);

        // Do not allow bypass unless market is _perfectly_ balanced. Adding this here to prevent maxPd bypass.
        await setMarketConfigurationById(bs, marketId, { liquidationMaxPd: bn(0) });

        // Attempt to liquidate again.
        await assertRevert(
          PerpMarketProxy.connect(desiredKeeper).liquidatePosition(trader.accountId, marketId),
          `LiquidationZeroCapacity()`,
          PerpMarketProxy
        );
      });

      // TODO: A concrete test with many whales all trading but one has over extended, partially liqudated.
      it('should revert when liq cap has been met and not endorsed (concrete)');

      it('should revert when pd is below maxPd but liquidation happens in the same block');
    });
  });
});
